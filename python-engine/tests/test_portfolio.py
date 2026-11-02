"""Portfolio analysis: checked against an independent numpy calculation, limiting cases and invalid input."""

import random

import numpy as np
import pytest

from src import portfolio_analysis as pa
from src.validation import ValidationError


def make_prices(seed, n=300, drift=0.0004, vol=0.01, start=100.0):
    rng = random.Random(seed)
    p = [start]
    for _ in range(n - 1):
        p.append(p[-1] * (1 + rng.gauss(drift, vol)))
    return p


SERIES = {"A": make_prices(1), "B": make_prices(2, vol=0.02), "C": make_prices(3, vol=0.005)}
WEIGHTS = {"A": 0.5, "B": 0.3, "C": 0.2}


def reference():
    rets = {k: np.array(v[1:]) / np.array(v[:-1]) - 1 for k, v in SERIES.items()}
    names = list(SERIES)
    R = np.column_stack([rets[k] for k in names])
    w = np.array([WEIGHTS[k] for k in names])
    port = R @ w
    cov = np.cov(R.T, ddof=1)
    var = w @ cov @ w
    contrib = 100 * w * (cov @ w) / var
    ann_vol = np.sqrt(var) * np.sqrt(252)
    index = np.concatenate([[1.0], np.cumprod(1 + port)])
    years = len(port) / 252
    return {
        "ann_vol": ann_vol * 100,
        "mean_ann": port.mean() * 252 * 100,
        "cagr": (index[-1] ** (1 / years) - 1) * 100,
        "total": (index[-1] - 1) * 100,
        "sharpe": (port.mean() * 252 - 0.05) / ann_vol,
        "contrib": contrib,
        "div": float(np.sum(w * np.sqrt(np.diag(cov)) * np.sqrt(252)) / ann_vol),
        "corr": np.corrcoef(R.T),
        "maxdd": float(np.min(index / np.maximum.accumulate(index) - 1) * 100),
        "eff": 1 / float(np.sum(w ** 2)),
    }


def test_matches_numpy_reference():
    r = pa.portfolio_analysis(WEIGHTS, SERIES, risk_free_rate_percent=5)
    ref = reference()
    assert r["volatility_annualized_percent"] == pytest.approx(ref["ann_vol"], rel=1e-9)
    assert r["mean_return_annualized_percent"] == pytest.approx(ref["mean_ann"], rel=1e-9)
    assert r["cagr_percent"] == pytest.approx(ref["cagr"], rel=1e-9)
    assert r["total_return_percent"] == pytest.approx(ref["total"], rel=1e-9)
    assert r["sharpe_ratio"] == pytest.approx(ref["sharpe"], rel=1e-9)
    assert r["diversification_ratio"] == pytest.approx(ref["div"], rel=1e-9)
    assert r["effective_number_of_assets"] == pytest.approx(ref["eff"], rel=1e-12)
    assert r["drawdown"]["max_drawdown_percent"] == pytest.approx(ref["maxdd"], rel=1e-9)
    got = [a["risk_contribution_percent"] for a in r["assets"]]
    assert got == pytest.approx(list(ref["contrib"]), rel=1e-9)
    assert sum(got) == pytest.approx(100.0, rel=1e-12)
    for i in range(3):
        for j in range(3):
            assert r["correlation_matrix"][i][j] == pytest.approx(ref["corr"][i][j], abs=1e-12)
    assert r["observations"] == 299 and r["largest_weight"] == 0.5
    assert "restored" in r["rebalancing_assumption"]


def test_returns_input_type_gives_the_same_answer():
    rets = {k: [(v[i] / v[i - 1] - 1) * 100 for i in range(1, len(v))] for k, v in SERIES.items()}
    a = pa.portfolio_analysis(WEIGHTS, SERIES)
    b = pa.portfolio_analysis(WEIGHTS, rets, input_type="returns_percent")
    assert b["volatility_annualized_percent"] == pytest.approx(a["volatility_annualized_percent"], rel=1e-9)
    assert b["total_return_percent"] == pytest.approx(a["total_return_percent"], rel=1e-9)


def test_identical_assets_have_no_diversification():
    s = {"X": SERIES["A"], "Y": SERIES["A"]}
    r = pa.portfolio_analysis({"X": 0.5, "Y": 0.5}, s)
    assert r["diversification_ratio"] == pytest.approx(1.0, rel=1e-9)
    assert r["correlation_matrix"][0][1] == pytest.approx(1.0, abs=1e-12)
    assert r["effective_number_of_assets"] == pytest.approx(2.0)
    assert [a["risk_contribution_percent"] for a in r["assets"]] == pytest.approx([50.0, 50.0])


def test_single_heavy_weight_is_reported():
    r = pa.portfolio_analysis({"A": 1.0, "B": 0.0, "C": 0.0}, SERIES)
    assert r["effective_number_of_assets"] == pytest.approx(1.0)
    assert r["largest_weight"] == 1.0


def test_flat_asset_has_undefined_correlation_not_zero():
    s = {"A": SERIES["A"], "FLAT": [100.0] * len(SERIES["A"])}
    r = pa.portfolio_analysis({"A": 0.5, "FLAT": 0.5}, s)
    assert r["correlation_matrix"][0][1] is None
    assert r["volatility_annualized_percent"] > 0


@pytest.mark.parametrize("weights", [
    {"A": 0.5, "B": 0.3},                         # missing name
    {"A": 0.5, "B": 0.3, "C": 0.3},               # sums to 1.1
    {"A": 1.2, "B": -0.1, "C": -0.1},             # short selling not supported
    {"A": 0.5, "B": 0.3, "Z": 0.2},               # unknown name
    {"A": "0.5", "B": 0.3, "C": 0.2},
    [0.5, 0.3, 0.2],
])
def test_bad_weights_are_refused(weights):
    with pytest.raises(ValidationError):
        pa.portfolio_analysis(weights, SERIES)


def test_bad_series_are_refused():
    with pytest.raises(ValidationError):
        pa.portfolio_analysis({"A": 0.5, "B": 0.5}, {"A": SERIES["A"], "B": SERIES["B"][:100]})   # different lengths
    with pytest.raises(ValidationError):
        pa.portfolio_analysis({"A": 1.0}, {"A": SERIES["A"]})                                     # needs 2+ assets
    with pytest.raises(ValidationError):
        pa.portfolio_analysis({"A": 0.5, "B": 0.5}, {"A": SERIES["A"], "B": [1, 2, None, 4, 5, 6, 7]})
    with pytest.raises(ValidationError):
        pa.portfolio_analysis({"A": 0.5, "B": 0.5}, {"A": SERIES["A"], "B": [1, 2, -3, 4, 5, 6, 7]})  # negative price
    with pytest.raises(ValidationError):
        pa.portfolio_analysis(WEIGHTS, SERIES, periods_per_year=0)
    with pytest.raises(ValidationError):
        pa.portfolio_analysis(WEIGHTS, SERIES, input_type="dollars")


def test_deterministic():
    assert pa.portfolio_analysis(WEIGHTS, SERIES) == pa.portfolio_analysis(WEIGHTS, SERIES)
