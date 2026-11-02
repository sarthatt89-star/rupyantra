"""The ONLY door into the Python engine. Function name + arguments in, one result envelope out.

Every envelope carries real execution metadata produced here (engine, function, executed, success, execution_id, duration_ms,
version). `executed` is true only if the requested function actually started. Nothing is faked and no user text is ever
evaluated as code: only the names in REGISTRY can be called.
"""

import json
import platform
import time
import uuid

from . import __version__
from . import anomaly_detection as an
from . import data_analysis as da
from . import forecasting as fc
from . import portfolio_analysis as pa
from . import risk_analysis as ra
from .validation import ValidationError

MAX_REQUEST_BYTES = 5_000_000

# name -> (function, required arguments, optional arguments)
REGISTRY = {
    "describe_series": (da.describe_series, ("values",), ()),
    "price_analysis": (da.price_analysis, ("prices",), ("periods_per_year", "risk_free_rate_percent")),
    "correlation_analysis": (da.correlation_analysis, ("series",), ("input_type",)),
    "max_drawdown": (ra.max_drawdown, ("prices",), ()),
    "value_at_risk": (ra.value_at_risk, ("returns_percent",), ("confidence", "method")),
    "worst_windows": (ra.worst_windows, ("prices",), ("windows",)),
    "risk_report": (ra.risk_report, ("prices",), ("periods_per_year",)),
    "batch_describe": (da.batch_describe, ("datasets",), ()),
    "portfolio_analysis": (pa.portfolio_analysis, ("weights", "series"), ("input_type", "periods_per_year", "risk_free_rate_percent")),
    "forecast": (fc.forecast, ("values",), ("horizon", "method", "confidence")),
    "backtest_forecast": (fc.backtest, ("values",), ("method", "horizon", "min_train", "max_origins", "confidence")),
    "scenario_projection": (fc.scenario_projection, ("start_value", "scenarios", "periods"), ("periods_per_year",)),
    "detect_anomalies": (an.detect_anomalies, ("values",), ("threshold", "expect_non_negative", "check_changes")),
}


def functions():
    return sorted(REGISTRY)


def info():
    """Health / identity (not a calculation, so no execution id)."""
    return {"engine": "python", "version": __version__, "python_version": platform.python_version(), "functions": functions()}


def _envelope(function, executed, success, started, **extra):
    out = {
        "engine": "python",
        "function": function if isinstance(function, str) and len(function) <= 80 else None,
        "executed": executed,
        "success": success,
        "execution_id": uuid.uuid4().hex,
        "duration_ms": (time.perf_counter() - started) * 1000.0,
        "version": __version__,
    }
    out.update(extra)
    return out


def _error(code, message):
    return {"code": code, "message": message}


def failure(function, code, message, executed=False):
    """A real failure envelope for callers (e.g. the HTTP service) that stop a request before or during execution."""
    return _envelope(function, executed, False, time.perf_counter(), error=_error(code, message))


def execute(function, args=None):
    """Run one approved function. Never raises."""
    t0 = time.perf_counter()
    try:
        if not isinstance(function, str) or function not in REGISTRY:
            return _envelope(function, False, False, t0, error=_error("NOT_APPROVED", "function is not approved"))
        fn, required, optional = REGISTRY[function]
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return _envelope(function, False, False, t0, error=_error("BAD_REQUEST", "args must be an object"))
        allowed = set(required) | set(optional)
        for key in args:
            if key not in allowed:
                return _envelope(function, False, False, t0, error=_error("BAD_REQUEST", "unknown argument: " + str(key)[:40]))
        for key in required:
            if key not in args:
                return _envelope(function, False, False, t0, error=_error("BAD_REQUEST", "missing argument: " + key))
        try:
            result = fn(**args)
            json.dumps(result, allow_nan=False)      # a NaN / infinity in a result is a bug, never sent on
        except ValidationError as e:
            return _envelope(function, True, False, t0, error=_error("INVALID_INPUT", e.message))
        except ValueError:
            return _envelope(function, True, False, t0, error=_error("NON_FINITE_RESULT", "the calculation did not produce a finite result"))
        return _envelope(function, True, True, t0, result=result)
    except Exception:  # noqa: BLE001 - details are deliberately not leaked to the caller
        return _envelope(function, True, False, t0, error=_error("INTERNAL_ERROR", "calculation failed"))


def execute_json(text):
    """JSON in, JSON out: {"function": "...", "args": {...}}."""
    t0 = time.perf_counter()
    if not isinstance(text, (str, bytes)):
        return json.dumps(_envelope(None, False, False, t0, error=_error("BAD_REQUEST", "request must be JSON text")))
    if len(text) > MAX_REQUEST_BYTES:
        return json.dumps(_envelope(None, False, False, t0, error=_error("TOO_LARGE", "request is too large")))
    try:
        req = json.loads(text)
    except (ValueError, RecursionError):
        return json.dumps(_envelope(None, False, False, t0, error=_error("BAD_REQUEST", "request is not valid JSON")))
    if not isinstance(req, dict) or "function" not in req:
        return json.dumps(_envelope(None, False, False, t0, error=_error("BAD_REQUEST", "function missing")))
    return json.dumps(execute(req.get("function"), req.get("args")), allow_nan=False)
