"""Responsibility split (C++ / Julia / Python / JavaScript) and basic code-safety rules of the Python engine."""

import glob
import os
import re

from src import engine

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
FORBIDDEN = [r"\beval\(", r"\bexec\(", r"os\.system", r"subprocess", r"\bpickle\b", r"importlib", r"__import__", r"\bcompile\(", r"\bopen\("]


def test_python_does_not_repeat_cpp_or_julia_work():
    names = " ".join(engine.REGISTRY)
    for word in ("emi", "sip", "lumpsum", "loan", "tax", "monte", "optimi", "frontier", "matrix"):
        assert word not in names, f"{word} belongs to the C++ or Julia engine"


def test_every_function_is_data_analysis_forecasting_risk_portfolio_or_anomaly():
    allowed = {"describe_series", "price_analysis", "correlation_analysis", "max_drawdown", "value_at_risk", "worst_windows",
               "risk_report", "batch_describe", "portfolio_analysis", "forecast", "backtest_forecast",
               "scenario_projection", "detect_anomalies"}
    assert set(engine.REGISTRY) == allowed


def test_no_dangerous_constructs_in_the_engine_source():
    for path in glob.glob(os.path.join(SRC, "*.py")):
        text = open(path, encoding="utf-8").read()
        code = "\n".join(line for line in text.splitlines() if not line.strip().startswith("#"))
        for pattern in FORBIDDEN:
            assert not re.search(pattern, code), f"{os.path.basename(path)} contains {pattern}"


def test_engine_has_no_third_party_runtime_dependency():
    stdlib_ok = {"math", "json", "platform", "time", "uuid", "statistics", "__future__"}
    for path in glob.glob(os.path.join(SRC, "*.py")):
        for m in re.finditer(r"^\s*(?:import|from)\s+([A-Za-z_][\w]*)", open(path, encoding="utf-8").read(), re.M):
            assert m.group(1) in stdlib_ok or m.group(1) == "src" or m.group(1) in {"data_analysis"}, f"{path}: {m.group(1)}"


def test_no_fabricated_data_in_results():
    # a result for unsupplied data must be refused, never invented
    r = engine.execute("forecast", {"values": []})
    assert r["success"] is False and "result" not in r
    r = engine.execute("portfolio_analysis", {"weights": {}, "series": {}})
    assert r["success"] is False and "result" not in r
