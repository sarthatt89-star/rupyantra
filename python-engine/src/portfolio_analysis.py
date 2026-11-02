"""Portfolio analysis on HISTORICAL data the caller supplies (long-only, fixed weights).

Assumption stated in every result: the portfolio is rebalanced back to the given weights every period.
Nothing here is a forecast. Units: returns and risk in PERCENT, ratios plain numbers.
"""

import math

from . import data_analysis as da
from . import financial_statistics as st
from . import risk_analysis as ra
from . import validation as v

NOTE = ("Historical analysis of the data you supplied, assuming the weights are restored every period. "
        "Past performance does not guarantee future returns.")


def _asset_returns(series, input_type):
    """name -> list of decimal period returns, all the same length."""
    if not isinstance(series, dict):
        raise v.ValidationError("series must be an object: {name: [numbers]}")
    if not (2 <= len(series) <= v.MAX_SERIES):
        raise v.ValidationError(f"series must contain 2 to {v.MAX_SERIES} named lists")
    kind = v.choice(input_type, "input_type", ("prices", "returns_percent"))
    out = {}
    for name, values in series.items():
        v.label(name, "series name")
        if kind == "prices":
            out[name] = da.simple_returns(v.prices(values, f"series[{name}]", min_len=6))
        else:
            out[name] = [x / 100.0 for x in v.returns_percent(values, f"series[{name}]", min_len=5)]
    length = len(next(iter(out.values())))
    if any(len(r) != length for r in out.values()):
        raise v.ValidationError("all series must have the same number of values")
    return out


def _weights(weights, names):
    if not isinstance(weights, dict):
        raise v.ValidationError("weights must be an object: {name: fraction}")
    if set(weights) != set(names):
        raise v.ValidationError("weights must have exactly the same names as series")
    w = {k: v.number(x, f"weights[{k}]", 0, 1) for k, x in weights.items()}
    if abs(sum(w.values()) - 1.0) > 1e-6:
        raise v.ValidationError("weights must add up to 1")
    return w


def portfolio_analysis(weights, series, input_type="prices", periods_per_year=252, risk_free_rate_percent=0):
    """Return, risk, drawdown, diversification and risk contribution of a fixed-weight portfolio."""
    rets = _asset_returns(series, input_type)
    names = list(rets)
    w = _weights(weights, names)
    ppy = v.integer(periods_per_year, "periods_per_year", 1, 366)
    rf = v.number(risk_free_rate_percent, "risk_free_rate_percent", -50, 100)
    n = len(rets[names[0]])
    wv = [w[k] for k in names]

    port = [math.fsum(w[k] * rets[k][t] for k in names) for t in range(n)]
    index = [1.0]
    for r in port:
        index.append(index[-1] * (1.0 + r))
    if min(index) <= 0:
        raise v.ValidationError("the portfolio loses everything in the supplied history")

    m = st.mean(port)
    sd = st.stdev(port)
    years = n / ppy
    cagr = index[-1] ** (1.0 / years) - 1.0
    ann_vol = sd * math.sqrt(ppy)
    downside = math.sqrt(math.fsum(min(r, 0.0) ** 2 for r in port) / n) * math.sqrt(ppy)
    excess = m * ppy - rf / 100.0

    # covariance based risk contribution
    k = len(names)
    cov = [[st.covariance(rets[names[i]], rets[names[j]]) for j in range(k)] for i in range(k)]
    cov_w = [math.fsum(cov[i][j] * wv[j] for j in range(k)) for i in range(k)]
    var_p = math.fsum(wv[i] * cov_w[i] for i in range(k))
    asset_vol = [math.sqrt(max(cov[i][i], 0.0)) * math.sqrt(ppy) for i in range(k)]
    contributions = [100.0 * wv[i] * cov_w[i] / var_p for i in range(k)] if var_p > 1e-18 else None
    weighted_vol = math.fsum(wv[i] * asset_vol[i] for i in range(k))
    div_ratio = weighted_vol / ann_vol if ann_vol > 1e-12 else None
    hhi = math.fsum(x * x for x in wv)

    assets = []
    for i, name in enumerate(names):
        assets.append({
            "name": name,
            "weight": wv[i],
            "mean_return_annualized_percent": st.mean(rets[name]) * ppy * 100.0,
            "volatility_annualized_percent": asset_vol[i] * 100.0,
            "risk_contribution_percent": None if contributions is None else contributions[i],
        })
    matrix = [[1.0 if i == j else st.correlation(rets[names[i]], rets[names[j]]) for j in range(k)] for i in range(k)]

    pct = [r * 100.0 for r in port]
    windows = [x for x in (1, 5, 21) if x < len(index) - 1]
    return {
        "observations": n,
        "periods_per_year": ppy,
        "years_covered": years,
        "rebalancing_assumption": "weights restored every period",
        "total_return_percent": (index[-1] - 1.0) * 100.0,
        "cagr_percent": cagr * 100.0,
        "mean_return_annualized_percent": m * ppy * 100.0,
        "volatility_annualized_percent": ann_vol * 100.0,
        "sharpe_ratio": excess / ann_vol if ann_vol > 1e-12 else None,
        "sortino_ratio": excess / downside if downside > 1e-12 else None,
        "weighted_average_volatility_percent": weighted_vol * 100.0,
        "diversification_ratio": div_ratio,
        "effective_number_of_assets": 1.0 / hhi,
        "largest_weight": max(wv),
        "assets": assets,
        "correlation_names": names,
        "correlation_matrix": matrix,
        "drawdown": ra.max_drawdown(index) if len(index) >= 2 else None,
        "var_95_historical": ra.value_at_risk(pct, 95, "historical") if n >= 10 else None,
        "worst_windows": ra.worst_windows(index, windows) if windows and len(index) >= 3 else None,
        "note": NOTE,
    }
