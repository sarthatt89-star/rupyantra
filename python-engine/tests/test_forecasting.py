"""Forecasting: exact answers on exact data, interval behaviour, honest backtests, reproducibility and bad input."""

import math
import random

import pytest

from src import forecasting as fc
from src.validation import ValidationError

LINE = [2.0 * x + 1.0 for x in range(30)]          # 1, 3, 5, ... 59


def noisy_line(seed, n=200, slope=2.0, noise=1.0):
    rng = random.Random(seed)
    return [100.0 + slope * t + rng.gauss(0, noise) for t in range(n)]


@pytest.mark.parametrize("method", ["drift", "linear_trend", "holt"])
def test_exact_line_is_continued_exactly(method):
    r = fc.forecast(LINE, horizon=5, method=method)
    assert [row["point"] for row in r["forecast"]] == pytest.approx([61, 63, 65, 67, 69], rel=1e-9)
    assert r["residual_std_dev"] == pytest.approx(0.0, abs=1e-9)
    assert "warning" in r                                   # zero-width interval is called out, not hidden


def test_naive_repeats_the_last_value():
    r = fc.forecast(LINE, horizon=3, method="naive")
    assert [row["point"] for row in r["forecast"]] == [59.0, 59.0, 59.0]
    assert r["last_observed"] == 59.0


def test_intervals_surround_the_point_and_widen():
    y = noisy_line(5)
    for method in ("naive", "drift", "holt"):
        rows = fc.forecast(y, horizon=12, method=method)["forecast"]
        assert all(r["lower"] < r["point"] < r["upper"] for r in rows)
        widths = [r["upper"] - r["lower"] for r in rows]
        assert widths == sorted(widths) and widths[-1] > widths[0]
    rows = fc.forecast(y, horizon=12, method="linear_trend")["forecast"]
    assert all(r["lower"] < r["point"] < r["upper"] for r in rows)


def test_higher_confidence_gives_wider_interval():
    y = noisy_line(6)
    a = fc.forecast(y, 3, "drift", confidence=80)["forecast"][0]
    b = fc.forecast(y, 3, "drift", confidence=99)["forecast"][0]
    assert (b["upper"] - b["lower"]) > (a["upper"] - a["lower"])
    assert a["point"] == b["point"]


def test_linear_trend_matches_least_squares_by_hand():
    y = [1.0, 2.0, 2.0, 4.0, 5.0]               # slope 1.0, intercept 0.8 (hand-computed)
    r = fc.forecast(y, horizon=1, method="linear_trend")
    assert r["forecast"][0]["point"] == pytest.approx(0.8 + 1.0 * 5, rel=1e-12)


def test_holt_reports_its_choice():
    r = fc.forecast(noisy_line(7), horizon=2, method="holt")
    assert r["smoothing"]["alpha"] in fc.ALPHAS and r["smoothing"]["beta"] in fc.BETAS


def test_reproducible():
    y = noisy_line(8)
    assert fc.forecast(y, 6, "holt") == fc.forecast(y, 6, "holt")
    assert fc.backtest(y, "drift", 3) == fc.backtest(y, "drift", 3)


def test_backtest_trend_method_beats_naive_on_a_trending_series():
    r = fc.backtest(noisy_line(9, n=300), method="linear_trend", horizon=1, max_origins=50)
    assert r["forecasts_tested"] == 50
    assert r["beats_naive"] is True and r["rmse_ratio_vs_naive"] < 1
    assert 70 <= r["interval_coverage_percent"] <= 100
    assert r["metrics"]["mape_percent"] > 0 and r["metrics"]["mae"] > 0


def test_backtest_errors_are_computed_from_the_future_only():
    # on an exact line the drift model never misses, and the naive model always misses by the slope
    r = fc.backtest(LINE, method="drift", horizon=1, min_train=10, max_origins=10)
    assert r["metrics"]["rmse"] == pytest.approx(0.0, abs=1e-9)
    assert r["naive_baseline_metrics"]["mae"] == pytest.approx(2.0, rel=1e-9)
    assert r["beats_naive"] is True


def test_backtest_with_zeros_does_not_divide_by_zero():
    y = [0.0] * 5 + [1.0, 0.0, 2.0, 0.0, 3.0, 0.0, 1.0, 0.0, 2.0, 1.0, 0.0, 1.0]
    r = fc.backtest(y, method="naive", horizon=1, min_train=6, max_origins=10)
    assert r["metrics"]["mape_values_used"] < r["forecasts_tested"] or r["metrics"]["mape_percent"] is None
    assert math.isfinite(r["metrics"]["rmse"])


def test_backtest_flags_small_samples():
    assert fc.backtest(noisy_line(1, n=40), "naive", 1, max_origins=5)["low_sample_warning"] is True


@pytest.mark.parametrize("kwargs", [
    {"values": [1, 2, 3, 4]},                                   # too short
    {"values": LINE, "horizon": 0},
    {"values": LINE, "horizon": 121},
    {"values": LINE, "horizon": 2.5},
    {"values": LINE, "method": "crystal_ball"},
    {"values": LINE, "confidence": 20},
    {"values": LINE[:-1] + [float("nan")]},
    {"values": LINE[:-1] + [None]},
    {"values": LINE[:-1] + ["x"]},
    {"values": "1,2,3,4,5,6"},
])
def test_forecast_bad_input_is_refused(kwargs):
    with pytest.raises(ValidationError):
        fc.forecast(**kwargs)


def test_backtest_bad_input_is_refused():
    with pytest.raises(ValidationError):
        fc.backtest([1.0] * 11)
    with pytest.raises(ValidationError):
        fc.backtest(LINE, horizon=30)
    with pytest.raises(ValidationError):
        fc.backtest([1.0] * (fc.MAX_BACKTEST_POINTS + 1))
    with pytest.raises(ValidationError):
        fc.backtest(LINE, min_train=29, horizon=2)


def test_scenario_projection_is_plain_compounding():
    r = fc.scenario_projection(100000, {"base": 12, "bad": -6, "flat": 0}, periods=12, periods_per_year=12)
    rows = {x["scenario"]: x for x in r["scenarios"]}
    assert rows["base"]["end_value"] == pytest.approx(112000.0, rel=1e-12)
    assert rows["bad"]["end_value"] == pytest.approx(94000.0, rel=1e-12)
    assert rows["flat"]["end_value"] == pytest.approx(100000.0, rel=1e-12)
    assert "assumption" in r["note"]
    for bad in ({}, {"x": "12"}, {"x": 5000}, {"": 5}):
        with pytest.raises(ValidationError):
            fc.scenario_projection(1000, bad, 12)
    with pytest.raises(ValidationError):
        fc.scenario_projection(-5, {"a": 1}, 12)


def test_large_history_is_handled_quickly():
    import time
    y = noisy_line(3, n=100000)
    t = time.perf_counter()
    r = fc.forecast(y, 12, "holt")
    assert time.perf_counter() - t < 15
    assert len(r["forecast"]) == 12
