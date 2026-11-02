"""Anomaly detection: injected problems are found, clean data stays quiet, missing data is never filled in."""

import random

import pytest

from src import anomaly_detection as an
from src.validation import ValidationError


def clean(seed=1, n=200):
    rng = random.Random(seed)
    return [100.0 + rng.gauss(0, 1) for _ in range(n)]


def types(r):
    return {(f["type"], f["index"]) for f in r["flags"]}


def test_clean_data_has_no_flags():
    r = an.detect_anomalies(clean())
    assert r["flag_count"] == 0 and r["flags"] == []
    assert "not proof" in r["note"]


def test_spike_is_found_with_an_explanation():
    y = clean()
    y[50] = 250.0
    r = an.detect_anomalies(y)
    assert ("level_outlier", 50) in types(r)
    assert ("sudden_change", 50) in types(r)
    flag = next(f for f in r["flags"] if f["type"] == "level_outlier")
    assert flag["severity"] == "high" and "median" in flag["explanation"] and flag["value"] == 250.0


def test_missing_values_are_reported_by_position_and_not_filled():
    y = clean(n=50)
    y[3], y[10], y[11] = None, float("nan"), float("inf")
    r = an.detect_anomalies(y)
    f = next(x for x in r["flags"] if x["type"] == "missing_values")
    assert f["positions"] == [3, 10, 11] and r["missing_count"] == 3 and r["usable_values"] == 47
    assert "not filled" in f["explanation"] or "not treated as zero" in f["explanation"]


def test_text_and_bool_count_as_missing():
    r = an.detect_anomalies([1, 2, "3", True, 5, 6, 7, 8, 9, 10])
    assert r["missing_count"] == 2


def test_stale_repeated_values():
    y = clean(n=60)
    for i in range(20, 27):
        y[i] = 99.5
    r = an.detect_anomalies(y)
    f = next(x for x in r["flags"] if x["type"] == "stale_repeated_value")
    assert f["index"] == 20 and "7 times" in f["explanation"]
    short = clean(n=60)
    for i in range(20, 24):
        short[i] = 99.5                      # run of 4 is normal
    assert not [x for x in an.detect_anomalies(short)["flags"] if x["type"] == "stale_repeated_value"]


def test_unexpected_negative_only_when_asked():
    y = [10.0, 12.0, 11.0, -4.0, 10.0, 11.0, 12.0, 10.0, 11.0, 12.0]
    assert not [f for f in an.detect_anomalies(y)["flags"] if f["type"] == "unexpected_negative"]
    r = an.detect_anomalies(y, expect_non_negative=True)
    assert ("unexpected_negative", 3) in types(r)


def test_constant_series_does_not_divide_by_zero():
    r = an.detect_anomalies([5.0] * 30)
    assert {f["type"] for f in r["flags"]} == {"stale_repeated_value"}


def test_too_few_values_explain_why_no_statistics():
    r = an.detect_anomalies([1.0, 2.0, 100.0])
    assert "statistics_note" in r and r["flag_count"] == 0


def test_gap_blocks_change_detection_across_missing_entries():
    y = clean(n=100)
    y[40] = None
    y[41] = y[39] * 1.0                      # a gap hides how many periods passed
    r = an.detect_anomalies(y)
    assert ("sudden_change", 41) not in types(r)


def test_flags_are_capped():
    y = [-1.0] * 100 + [5.0 * (-1) ** i for i in range(1, 500)]
    r = an.detect_anomalies(y, expect_non_negative=True)
    assert len(r["flags"]) == an.MAX_FLAGS and r["flags_truncated"] and r["flag_count"] > an.MAX_FLAGS


def test_high_severity_comes_first():
    y = clean()
    y[10] = 500.0
    for i in range(80, 90):
        y[i] = 100.0
    sev = [f["severity"] for f in an.detect_anomalies(y)["flags"]]
    assert sev == sorted(sev, key=["high", "medium", "low"].index)


@pytest.mark.parametrize("kwargs", [
    {"values": "1,2,3"},
    {"values": []},
    {"values": clean(), "threshold": 1},
    {"values": clean(), "threshold": 50},
    {"values": clean(), "expect_non_negative": "yes"},
    {"values": clean(), "check_changes": 1},
])
def test_bad_input_is_refused(kwargs):
    with pytest.raises(ValidationError):
        an.detect_anomalies(**kwargs)


def test_large_dataset():
    import time
    y = clean(n=100000)
    y[777] = 1e6
    t = time.perf_counter()
    r = an.detect_anomalies(y)
    assert time.perf_counter() - t < 10
    assert ("level_outlier", 777) in types(r)
    assert an.detect_anomalies(y) == r
