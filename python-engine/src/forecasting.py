"""Statistical forecasting from a history the caller supplies, with honest uncertainty and a built-in backtest.

These are mechanical extrapolations of PAST data. They are not predictions of the market and never a guaranteed return.
Prediction intervals are approximate (they assume roughly normal, independent errors); the backtest reports how often the
real value really fell inside them. All methods are deterministic: the same input gives the same output.
"""

import math
from statistics import NormalDist

from . import financial_statistics as st
from . import validation as v

METHODS = ("naive", "drift", "linear_trend", "holt")
MAX_BACKTEST_POINTS = 5000
MAX_HORIZON = 120
ALPHAS = (0.2, 0.4, 0.6, 0.8, 0.95)
BETAS = (0.1, 0.3, 0.5)

NOTE = ("A statistical extrapolation of the supplied history, not a prediction or a guaranteed return. "
        "Intervals are approximate and assume similar behaviour continues.")


def _z(confidence):
    return NormalDist().inv_cdf(0.5 + confidence / 200.0)


def _holt_run(y, alpha, beta):
    level, trend = y[0], y[1] - y[0]
    sse = 0.0
    errors = []
    for t in range(1, len(y)):
        pred = level + trend
        e = y[t] - pred
        errors.append(e)
        sse += e * e
        new_level = alpha * y[t] + (1 - alpha) * (level + trend)
        trend = beta * (new_level - level) + (1 - beta) * trend
        level = new_level
    return sse, errors, level, trend


def _fit(y, h, method):
    """Point forecasts for steps 1..h, one-step in-sample errors, residual degrees of freedom, regression helpers."""
    n = len(y)
    if method == "naive":
        errors = [y[t] - y[t - 1] for t in range(1, n)]
        return [y[-1]] * h, errors, 1, None
    if method == "drift":
        slope = (y[-1] - y[0]) / (n - 1)
        errors = [y[t] - y[t - 1] - slope for t in range(1, n)]
        return [y[-1] + slope * k for k in range(1, h + 1)], errors, 2, None
    if method == "linear_trend":
        xs = list(range(n))
        mx, my = st.mean(xs), st.mean(y)
        sxx = math.fsum((x - mx) ** 2 for x in xs)
        slope = math.fsum((x - mx) * (b - my) for x, b in zip(xs, y)) / sxx
        icpt = my - slope * mx
        errors = [y[t] - (icpt + slope * t) for t in range(n)]
        return [icpt + slope * (n - 1 + k) for k in range(1, h + 1)], errors, 2, (mx, sxx)
    best = None
    for a in ALPHAS:
        for b in BETAS:
            sse, errors, level, trend = _holt_run(y, a, b)
            if best is None or sse < best[0] - 1e-12:
                best = (sse, errors, level, trend, a, b)
    _, errors, level, trend, a, b = best
    return [level + trend * k for k in range(1, h + 1)], errors, 3, (a, b)


def _sigma(errors, dof_lost):
    n = len(errors)
    return math.sqrt(math.fsum(e * e for e in errors) / max(n - dof_lost, 1))


def _forecast_rows(y, h, method, confidence):
    points, errors, dof, extra = _fit(y, h, method)
    sigma = _sigma(errors, dof)
    z = _z(confidence)
    n = len(y)
    rows = []
    for k, p in enumerate(points, start=1):
        if method == "linear_trend":
            mx, sxx = extra
            half = z * sigma * math.sqrt(1.0 + 1.0 / n + ((n - 1 + k) - mx) ** 2 / sxx)
        else:
            half = z * sigma * math.sqrt(k)
        rows.append({"step": k, "point": p, "lower": p - half, "upper": p + half})
    return rows, sigma, extra


def forecast(values, horizon=6, method="drift", confidence=95):
    """Extrapolate a history (oldest first, equally spaced, in the units you supply) for 1..120 steps."""
    y = v.series(values, "values", min_len=5, hi=1e15, lo=-1e15)
    h = v.integer(horizon, "horizon", 1, MAX_HORIZON)
    method = v.choice(method, "method", METHODS)
    conf = v.number(confidence, "confidence", 50, 99.9)
    rows, sigma, extra = _forecast_rows(y, h, method, conf)
    out = {
        "method": method,
        "observations": len(y),
        "horizon": h,
        "confidence_percent": conf,
        "last_observed": y[-1],
        "forecast": rows,
        "residual_std_dev": sigma,
        "interval_note": "Approximate prediction interval; real outcomes can fall outside it.",
        "note": NOTE,
    }
    if method == "holt":
        out["smoothing"] = {"alpha": extra[0], "beta": extra[1], "chosen_by": "lowest in-sample one-step error"}
    if sigma <= 1e-9 * max(1.0, abs(y[-1])):
        out["warning"] = "The history follows this method exactly, so the interval has zero width. That says nothing about the future."
    return out


def _metrics(errors, actuals):
    n = len(errors)
    nonzero = [(e, a) for e, a in zip(errors, actuals) if a != 0.0]
    return {
        "mae": math.fsum(abs(e) for e in errors) / n,
        "rmse": math.sqrt(math.fsum(e * e for e in errors) / n),
        "bias": math.fsum(errors) / n,
        "mape_percent": (math.fsum(abs(e / a) for e, a in nonzero) / len(nonzero) * 100.0) if nonzero else None,
        "mape_values_used": len(nonzero),
    }


def backtest(values, method="drift", horizon=1, min_train=None, max_origins=30, confidence=95):
    """Walk-forward test: fit on the past only, forecast `horizon` steps ahead, compare with what really happened."""
    y = v.series(values, "values", min_len=12, max_len=MAX_BACKTEST_POINTS, hi=1e15, lo=-1e15)
    method = v.choice(method, "method", METHODS)
    h = v.integer(horizon, "horizon", 1, 24)
    conf = v.number(confidence, "confidence", 50, 99.9)
    origins_wanted = v.integer(max_origins, "max_origins", 3, 100)
    n = len(y)
    start = v.integer(min_train, "min_train", 5, n - h) if min_train is not None else max(8, n // 2)
    if start > n - h:
        raise v.ValidationError("the history is too short for this horizon")
    last_origin = n - h
    count = last_origin - start + 1
    step = max(1, count // origins_wanted)
    origins = list(range(start, last_origin + 1, step))[-origins_wanted:]
    errors, naive_errors, actuals, inside = [], [], [], 0
    for o in origins:
        train = y[:o]
        rows, _, _ = _forecast_rows(train, h, method, conf)
        nrows, _, _ = _forecast_rows(train, h, "naive", conf)
        actual = y[o + h - 1]
        r = rows[-1]
        errors.append(actual - r["point"])
        naive_errors.append(actual - nrows[-1]["point"])
        actuals.append(actual)
        if r["lower"] <= actual <= r["upper"]:
            inside += 1
    m, nm = _metrics(errors, actuals), _metrics(naive_errors, actuals)
    ratio = m["rmse"] / nm["rmse"] if nm["rmse"] > 0 else None
    return {
        "method": method,
        "horizon": h,
        "observations": n,
        "forecasts_tested": len(origins),
        "metrics": m,
        "naive_baseline_metrics": nm,
        "rmse_ratio_vs_naive": ratio,
        "beats_naive": None if ratio is None else ratio < 1.0,
        "interval_coverage_percent": 100.0 * inside / len(origins),
        "target_coverage_percent": conf,
        "low_sample_warning": len(origins) < 20,
        "note": "Walk-forward test on the supplied history only. A method that did well in the past can still fail in future. " + NOTE,
    }


def scenario_projection(start_value, scenarios, periods, periods_per_year=12):
    """Compound a starting value under growth assumptions YOU choose (no history involved)."""
    base = v.number(start_value, "start_value", 0, 1e15)
    n = v.integer(periods, "periods", 1, 1200)
    ppy = v.integer(periods_per_year, "periods_per_year", 1, 366)
    if not isinstance(scenarios, dict) or not (1 <= len(scenarios) <= 10):
        raise v.ValidationError("scenarios must be an object with 1 to 10 named annual growth rates in percent")
    rows = []
    for name, rate in scenarios.items():
        v.label(name, "scenario name")
        g = v.number(rate, f"scenarios[{name}]", -100, 1000)
        per_period = (1.0 + g / 100.0) ** (1.0 / ppy)
        rows.append({"scenario": name, "annual_growth_percent": g, "end_value": base * per_period ** n,
                     "change_percent": (per_period ** n - 1.0) * 100.0})
    return {"start_value": base, "periods": n, "periods_per_year": ppy, "scenarios": rows,
            "note": "Arithmetic on growth rates you assumed; these are assumptions, not predictions."}
