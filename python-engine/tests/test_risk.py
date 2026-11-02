import math
import random
from statistics import NormalDist

import pytest

from src import risk_analysis as ra
from src import validation as v


def test_max_drawdown_known_answer():
    r = ra.max_drawdown([100, 120, 90, 110, 80, 130])
    assert r["max_drawdown_percent"] == pytest.approx(-100 / 3, rel=1e-12)
    assert (r["peak_index"], r["trough_index"], r["recovery_index"]) == (1, 4, 5)
    assert r["periods_peak_to_trough"] == 3 and r["recovered"] is True
    assert r["current_drawdown_percent"] == 0.0


def test_max_drawdown_never_recovered_and_never_fell():
    r = ra.max_drawdown([100, 50, 60])
    assert r["max_drawdown_percent"] == -50.0 and r["recovery_index"] is None and r["recovered"] is False
    assert r["current_drawdown_percent"] == pytest.approx(-40.0)
    up = ra.max_drawdown([1, 2, 3, 4])
    assert up["max_drawdown_percent"] == 0.0 and up["recovered"] is True and up["recovery_index"] is None


def test_max_drawdown_matches_numpy():
    np = pytest.importorskip("numpy")
    rng = random.Random(21)
    p = [100.0]
    for _ in range(2000):
        p.append(p[-1] * (1 + rng.gauss(0, 0.02)))
    arr = np.array(p)
    expected = float(np.min(arr / np.maximum.accumulate(arr) - 1) * 100)
    assert ra.max_drawdown(p)["max_drawdown_percent"] == pytest.approx(expected, rel=1e-12)


def test_historical_var_cvar_match_numpy():
    np = pytest.importorskip("numpy")
    rng = random.Random(8)
    r = [rng.gauss(0.05, 1.2) for _ in range(1000)]
    for conf in (95, 99):
        out = ra.value_at_risk(r, conf)
        q = float(np.percentile(r, 100 - conf))
        tail = [x for x in r if x <= q]
        assert out["var_percent"] == pytest.approx(-q, rel=1e-12)
        assert out["cvar_percent"] == pytest.approx(-float(np.mean(tail)), rel=1e-12)
        assert out["cvar_percent"] >= out["var_percent"]
        assert out["low_sample_warning"] is False


def test_parametric_var_known_formula():
    r = [(-1) ** i * 1.0 + 0.2 for i in range(40)]
    out = ra.value_at_risk(r, 95, "parametric")
    mu = sum(r) / len(r)
    sd = math.sqrt(sum((x - mu) ** 2 for x in r) / (len(r) - 1))
    assert out["var_percent"] == pytest.approx(1.6448536269514729 * sd - mu, rel=1e-12)
    assert out["cvar_percent"] == pytest.approx(NormalDist().pdf(-1.6448536269514729) / 0.05 * sd - mu, rel=1e-9)
    assert "normally distributed" in out["assumption"]


def test_higher_confidence_means_larger_var():
    rng = random.Random(2)
    r = [rng.gauss(0, 1) for _ in range(2000)]
    assert ra.value_at_risk(r, 99)["var_percent"] > ra.value_at_risk(r, 95)["var_percent"]


def test_small_samples_are_flagged_not_hidden():
    out = ra.value_at_risk([-2, 1, 0.5, 0.3, -0.1, 0.2, 0.4, 0.1, -0.3, 0.6], 95)
    assert out["low_sample_warning"] is True and out["observations"] == 10


def test_var_rejects_bad_input():
    good = [0.1] * 20
    for bad in ([0.1] * 9, [-101.0] + [0.1] * 20, [None] + [0.1] * 20, "x", None):
        with pytest.raises(v.ValidationError):
            ra.value_at_risk(bad)
    for conf in (89, 100, float("nan"), "95", True):
        with pytest.raises(v.ValidationError):
            ra.value_at_risk(good, conf)
    with pytest.raises(v.ValidationError):
        ra.value_at_risk(good, 95, "montecarlo")


def test_worst_windows_known_answer():
    r = ra.worst_windows([100, 110, 99, 121], windows=[1, 2])
    one, two = r["windows"]
    assert one["worst_return_percent"] == pytest.approx(-10.0) and one["worst_start_index"] == 1
    assert one["best_return_percent"] == pytest.approx(22.22222222222222) and one["best_start_index"] == 2
    assert two["worst_return_percent"] == pytest.approx(-1.0) and two["worst_start_index"] == 0
    assert two["best_return_percent"] == pytest.approx(10.0) and two["windows_measured"] == 2


def test_worst_windows_rejects_bad_windows():
    p = [100, 101, 102, 103]
    for w in ([], [0], [4], [1.5], "1", None, list(range(1, 12))):
        with pytest.raises(v.ValidationError):
            ra.worst_windows(p, w)


def test_risk_report_has_all_parts_and_is_reproducible():
    rng = random.Random(4)
    p = [100.0]
    for _ in range(300):
        p.append(p[-1] * (1 + rng.gauss(0.0003, 0.012)))
    a = ra.risk_report(p)
    assert a == ra.risk_report(p)
    assert a["annualized_volatility_percent"] > 0
    assert a["drawdown"]["max_drawdown_percent"] <= 0
    assert a["var_99_historical"]["var_percent"] >= a["var_95_historical"]["var_percent"]
    assert len(a["worst_windows"]["windows"]) == 3
    with pytest.raises(v.ValidationError):
        ra.risk_report([100, 101, 102])
