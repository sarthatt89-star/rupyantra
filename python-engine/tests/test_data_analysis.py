import math
import random

import pytest

from src import data_analysis as da
from src import financial_statistics as st
from src import validation as v


def test_summary_known_answers():
    s = da.describe_series([1, 2, 3, 4, 5])["summary"]
    assert s["count"] == 5 and s["mean"] == 3.0 and s["median"] == 3.0
    assert s["std_dev"] == pytest.approx(math.sqrt(2.5), rel=1e-14)
    assert s["p25"] == 2.0 and s["p75"] == 4.0 and s["min"] == 1.0 and s["max"] == 5.0
    assert s["skewness"] == pytest.approx(0.0, abs=1e-14)


def test_single_value_summary_does_not_divide_by_zero():
    s = da.describe_series([7])["summary"]
    assert s["std_dev"] is None and s["skewness"] is None and s["excess_kurtosis"] is None
    assert s["mean"] == 7.0


def test_percentile_matches_numpy():
    np = pytest.importorskip("numpy")
    rng = random.Random(3)
    data = [rng.gauss(0, 5) for _ in range(257)]
    for p in (0, 1, 5, 25, 50, 75, 95, 99, 100):
        assert st.percentile(data, p) == pytest.approx(float(np.percentile(data, p)), rel=1e-12, abs=1e-12)


def test_statistics_match_numpy():
    np = pytest.importorskip("numpy")
    rng = random.Random(11)
    a = [rng.gauss(1, 2) for _ in range(500)]
    b = [x * 0.5 + rng.gauss(0, 1) for x in a]
    assert st.mean(a) == pytest.approx(float(np.mean(a)), rel=1e-12)
    assert st.stdev(a) == pytest.approx(float(np.std(a, ddof=1)), rel=1e-12)
    assert st.correlation(a, b) == pytest.approx(float(np.corrcoef(a, b)[0, 1]), rel=1e-12)
    assert st.covariance(a, b) == pytest.approx(float(np.cov(a, b)[0, 1]), rel=1e-12)


def test_constant_growth_prices():
    prices = [100 * 1.01 ** i for i in range(13)]
    r = da.price_analysis(prices, periods_per_year=12)
    assert r["years_covered"] == 1.0
    assert r["total_return_percent"] == pytest.approx(12.682503013196977, rel=1e-12)
    assert r["cagr_percent"] == pytest.approx(12.682503013196977, rel=1e-12)
    assert r["period_volatility_percent"] == pytest.approx(0.0, abs=1e-10)
    assert r["trend"]["annualized_growth_percent"] == pytest.approx(12.682503013196977, rel=1e-9)
    assert r["trend"]["r_squared"] == pytest.approx(1.0, abs=1e-12)


def test_price_analysis_matches_numpy_on_random_walk():
    np = pytest.importorskip("numpy")
    rng = random.Random(5)
    p = [100.0]
    for _ in range(750):
        p.append(p[-1] * (1 + rng.gauss(0.0004, 0.01)))
    r = da.price_analysis(p, periods_per_year=252)
    rets = np.array(p[1:]) / np.array(p[:-1]) - 1
    assert r["period_volatility_percent"] == pytest.approx(float(np.std(rets, ddof=1)) * 100, rel=1e-10)
    assert r["annualized_volatility_percent"] == pytest.approx(float(np.std(rets, ddof=1)) * 100 * math.sqrt(252), rel=1e-10)
    assert r["mean_period_return_percent"] == pytest.approx(float(np.mean(rets)) * 100, rel=1e-10)
    slope = np.polyfit(np.arange(len(p)), np.log(p), 1)[0]
    assert r["trend"]["annualized_growth_percent"] == pytest.approx((math.exp(slope * 252) - 1) * 100, rel=1e-8)
    assert r["total_return_percent"] == pytest.approx((p[-1] / p[0] - 1) * 100, rel=1e-12)


def test_sharpe_is_undefined_not_infinite_when_nothing_varies():
    r = da.price_analysis([100, 100, 100, 100])
    assert r["sharpe_ratio"] is None
    assert r["trend"]["r_squared"] is None
    assert r["total_return_percent"] == 0.0


def test_price_analysis_rejects_bad_input():
    for bad in ([100, 101], [100, 0, 101], [100, -5, 101], [100, None, 102], "abc", None, [100, float("nan"), 101]):
        with pytest.raises(v.ValidationError):
            da.price_analysis(bad)
    with pytest.raises(v.ValidationError):
        da.price_analysis([1, 2, 3], periods_per_year=0)
    with pytest.raises(v.ValidationError):
        da.price_analysis([1, 2, 3], risk_free_rate_percent=500)


def test_correlation_known_cases():
    r = da.correlation_analysis({"a": [1, 2, -1, 3], "b": [-1, -2, 1, -3], "c": [2, 4, -2, 6]}, input_type="returns_percent")
    m = r["matrix"]
    assert m[0][1] == pytest.approx(-1.0, abs=1e-12)
    assert m[0][2] == pytest.approx(1.0, abs=1e-12)
    assert m[1][2] == pytest.approx(-1.0, abs=1e-12)
    assert all(m[i][i] == 1.0 for i in range(3)) and m[0][1] == m[1][0]
    assert r["most_correlated"]["correlation"] == pytest.approx(1.0)
    assert r["least_correlated"]["correlation"] == pytest.approx(-1.0)


def test_correlation_of_a_flat_series_is_undefined_not_zero():
    r = da.correlation_analysis({"x": [1, 2, 3, 1], "flat": [0, 0, 0, 0]}, input_type="returns_percent")
    assert r["matrix"][0][1] is None and r["undefined_pairs"] == 1
    assert "most_correlated" not in r


def test_correlation_from_prices_uses_returns():
    np = pytest.importorskip("numpy")
    rng = random.Random(9)
    a, b = [100.0], [50.0]
    for _ in range(200):
        z = rng.gauss(0, 1)
        a.append(a[-1] * (1 + 0.01 * z))
        b.append(b[-1] * (1 + 0.008 * z + 0.004 * rng.gauss(0, 1)))
    r = da.correlation_analysis({"A": a, "B": b})
    ra_ = np.array(a[1:]) / np.array(a[:-1]) - 1
    rb_ = np.array(b[1:]) / np.array(b[:-1]) - 1
    assert r["matrix"][0][1] == pytest.approx(float(np.corrcoef(ra_, rb_)[0, 1]), rel=1e-10)
    assert r["observations"] == 200


def test_correlation_rejects_bad_input():
    with pytest.raises(v.ValidationError):
        da.correlation_analysis({"a": [1, 2, 3, 4]})                                   # one series only
    with pytest.raises(v.ValidationError):
        da.correlation_analysis({"a": [1, 2, 3, 4], "b": [1, 2, 3]})                   # lengths differ
    with pytest.raises(v.ValidationError):
        da.correlation_analysis({"a": [1, 2, 3, 4], "b": [1, 2, 3, 4]}, input_type="x")
    with pytest.raises(v.ValidationError):
        da.correlation_analysis([1, 2])
    with pytest.raises(v.ValidationError):
        da.correlation_analysis({"a": [1, 2, 3, 4], "": [1, 2, 3, 4]})
    with pytest.raises(v.ValidationError):
        da.correlation_analysis({f"s{i}": [1, 2, 3, 4] for i in range(51)})


def test_results_are_reproducible():
    p = [100, 101, 99, 102, 105, 103, 108]
    assert da.price_analysis(p) == da.price_analysis(p)
