"""Historical risk measures: drawdown, Value at Risk, Conditional VaR and worst periods in the supplied history.
Inputs in PERCENT (returns) or price levels. Losses are reported as positive percentages."""

import math
from statistics import NormalDist

from . import data_analysis as da
from . import financial_statistics as st
from . import validation as v

NOTE = ("Measured on the history you supplied. VaR is not the worst possible loss: bigger losses than VaR happen in the "
        "remaining (100 - confidence)% of periods. Past data does not guarantee future results.")
MIN_TAIL = 5


def max_drawdown(prices):
    """Largest fall from a peak to a later low, and when it happened."""
    p = v.prices(prices, min_len=2)
    peak_i = 0
    best = 0.0
    best_peak = best_trough = 0
    for i, x in enumerate(p):
        if x > p[peak_i]:
            peak_i = i
        dd = x / p[peak_i] - 1.0
        if dd < best:
            best, best_peak, best_trough = dd, peak_i, i
    recovery = None
    if best < 0:
        target = p[best_peak]
        for j in range(best_trough + 1, len(p)):
            if p[j] >= target:
                recovery = j
                break
    run_peak = max(p)
    return {
        "max_drawdown_percent": best * 100.0,
        "peak_index": best_peak,
        "trough_index": best_trough,
        "recovery_index": recovery,
        "periods_peak_to_trough": best_trough - best_peak,
        "recovered": recovery is not None if best < 0 else True,
        "current_drawdown_percent": (p[-1] / run_peak - 1.0) * 100.0,
        "note": "Peak-to-trough fall inside the supplied prices; index 0 is the first (oldest) value.",
    }


def value_at_risk(returns_percent, confidence=95, method="historical"):
    """VaR and CVaR of one period, as positive loss percentages."""
    r = v.returns_percent(returns_percent, min_len=10)
    conf = v.number(confidence, "confidence", 90, 99.9)
    method = v.choice(method, "method", ("historical", "parametric"))
    tail_prob = 1.0 - conf / 100.0
    out = {"method": method, "confidence_percent": conf, "observations": len(r)}
    if method == "historical":
        q = st.percentile(r, 100.0 - conf)
        tail = [x for x in r if x <= q]
        out["var_percent"] = -q
        out["cvar_percent"] = -st.mean(tail)
        out["tail_observations"] = len(tail)
        out["low_sample_warning"] = len(tail) < MIN_TAIL
    else:
        mu, sd = st.mean(r), st.stdev(r)
        nd = NormalDist()
        z = nd.inv_cdf(tail_prob)
        out["var_percent"] = -(mu + z * sd)
        out["cvar_percent"] = -(mu - sd * nd.pdf(z) / tail_prob)
        out["assumption"] = "Returns treated as normally distributed; real markets have fatter tails, so this can understate risk."
        out["low_sample_warning"] = len(r) < 30
    out["note"] = NOTE
    return out


def worst_windows(prices, windows=(1, 5, 21)):
    """Best and worst return over rolling windows of the supplied history (a data-driven stress view)."""
    p = v.prices(prices, min_len=3)
    if not isinstance(windows, (list, tuple)) or not (1 <= len(windows) <= 10):
        raise v.ValidationError("windows must be a list of 1 to 10 window lengths")
    rows = []
    for w in windows:
        w = v.integer(w, "windows[]", 1, len(p) - 1)
        rets = [(p[i + w] / p[i] - 1.0) * 100.0 for i in range(len(p) - w)]
        worst_i = min(range(len(rets)), key=rets.__getitem__)
        best_i = max(range(len(rets)), key=rets.__getitem__)
        rows.append({"window_periods": w, "windows_measured": len(rets),
                     "worst_return_percent": rets[worst_i], "worst_start_index": worst_i,
                     "best_return_percent": rets[best_i], "best_start_index": best_i})
    return {"windows": rows, "note": "Worst and best past windows inside the supplied data; a worse period can occur in future."}


def risk_report(prices, periods_per_year=252):
    """One-stop risk summary of a price history."""
    p = v.prices(prices, min_len=12)
    ppy = v.integer(periods_per_year, "periods_per_year", 1, 366)
    rets = [x * 100.0 for x in da.simple_returns(p)]
    sd = st.stdev(rets)
    return {
        "observations": len(p),
        "annualized_volatility_percent": sd * math.sqrt(ppy),
        "drawdown": max_drawdown(p),
        "var_95_historical": value_at_risk(rets, 95, "historical") if len(rets) >= 10 else None,
        "var_99_historical": value_at_risk(rets, 99, "historical") if len(rets) >= 10 else None,
        "worst_windows": worst_windows(p, [w for w in (1, 5, 21) if w < len(p)]),
        "note": NOTE,
    }
