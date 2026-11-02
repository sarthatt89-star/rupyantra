"""Historical data analysis on prices the caller supplies. Nothing here is a forecast or a promise of future returns."""

import math

from . import financial_statistics as st
from . import validation as v

NOTE = "Historical analysis of the data you supplied; past performance does not guarantee future returns."


def simple_returns(prices):
    """Decimal period returns (0.01 = 1%) from positive prices."""
    return [prices[i] / prices[i - 1] - 1.0 for i in range(1, len(prices))]


def describe_series(values):
    """Statistical summary of any list of numbers (units are yours)."""
    vals = v.series(values, "values", min_len=1)
    return {"summary": st.summary(vals), "note": "Descriptive statistics of the supplied numbers."}


def price_analysis(prices, periods_per_year=252, risk_free_rate_percent=0):
    """Return, volatility, growth and trend of a price history (oldest first, equally spaced)."""
    p = v.prices(prices, min_len=3)
    ppy = v.integer(periods_per_year, "periods_per_year", 1, 366)
    rf = v.number(risk_free_rate_percent, "risk_free_rate_percent", -50, 100)
    n = len(p)
    rets = simple_returns(p)
    years = (n - 1) / ppy
    total = p[-1] / p[0] - 1.0
    cagr = (p[-1] / p[0]) ** (1.0 / years) - 1.0
    m = st.mean(rets)
    sd = st.stdev(rets)
    ann_vol = sd * math.sqrt(ppy)
    sharpe = None
    if ann_vol > 0:
        sharpe = (m * ppy - rf / 100.0) / ann_vol

    # least-squares line through ln(price): the slope is the average continuous growth per period
    xs = list(range(n))
    ys = [math.log(x) for x in p]
    mx, my = st.mean(xs), st.mean(ys)
    sxx = math.fsum((x - mx) ** 2 for x in xs)
    sxy = math.fsum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    ss_tot = math.fsum((y - my) ** 2 for y in ys)
    ss_res = math.fsum((y - (my + slope * (x - mx))) ** 2 for x, y in zip(xs, ys))
    r2 = None if ss_tot <= 0 else max(0.0, 1.0 - ss_res / ss_tot)

    pct = [r * 100.0 for r in rets]
    return {
        "observations": n,
        "periods_per_year": ppy,
        "years_covered": years,
        "total_return_percent": total * 100.0,
        "cagr_percent": cagr * 100.0,
        "mean_period_return_percent": m * 100.0,
        "period_volatility_percent": sd * 100.0,
        "annualized_volatility_percent": ann_vol * 100.0,
        "sharpe_ratio": sharpe,
        "trend": {
            "annualized_growth_percent": (math.exp(slope * ppy) - 1.0) * 100.0,
            "r_squared": r2,
            "meaning": "Straight-line fit through the log of the supplied prices; a description of the past, not a forecast.",
        },
        "return_summary_percent": st.summary(pct),
        "note": NOTE,
    }


def correlation_analysis(series, input_type="prices"):
    """Pairwise correlation of period returns between 2 to 50 named series of equal length."""
    if not isinstance(series, dict):
        raise v.ValidationError("series must be an object: {name: [numbers]}")
    if not (2 <= len(series) <= v.MAX_SERIES):
        raise v.ValidationError(f"series must contain 2 to {v.MAX_SERIES} named lists")
    kind = v.choice(input_type, "input_type", ("prices", "returns_percent"))
    names, data = [], []
    for name, values in series.items():
        v.label(name, "series name")
        if kind == "prices":
            data.append(simple_returns(v.prices(values, f"series[{name}]", min_len=4)))
        else:
            data.append([x / 100.0 for x in v.returns_percent(values, f"series[{name}]", min_len=3)])
        names.append(name)
    length = len(data[0])
    if any(len(d) != length for d in data):
        raise v.ValidationError("all series must have the same number of values")

    k = len(names)
    matrix = [[1.0 if i == j else None for j in range(k)] for i in range(k)]
    pairs = []
    for i in range(k):
        for j in range(i + 1, k):
            c = st.correlation(data[i], data[j])
            matrix[i][j] = matrix[j][i] = c
            if c is not None:
                pairs.append((c, names[i], names[j]))
    out = {"names": names, "observations": length, "matrix": matrix, "undefined_pairs": sum(
        1 for i in range(k) for j in range(i + 1, k) if matrix[i][j] is None)}
    if pairs:
        hi, lo = max(pairs), min(pairs)
        out["most_correlated"] = {"a": hi[1], "b": hi[2], "correlation": hi[0]}
        out["least_correlated"] = {"a": lo[1], "b": lo[2], "correlation": lo[0]}
        out["average_pair_correlation"] = st.mean([c for c, _, _ in pairs])
    out["note"] = "Correlation of past returns; it changes over time and is not a promise about the future. "\
                  "A series that never changes has no defined correlation (shown as null)."
    return out


def batch_describe(datasets):
    """Summaries of up to 50 named series in one call (batch analysis). Each series is processed independently."""
    if not isinstance(datasets, dict) or not (1 <= len(datasets) <= v.MAX_SERIES):
        raise v.ValidationError(f"datasets must be an object with 1 to {v.MAX_SERIES} named lists")
    out = {}
    for name, values in datasets.items():
        v.label(name, "dataset name")
        out[name] = st.summary(v.series(values, f"datasets[{name}]", min_len=1))
    return {"count": len(out), "summaries": out, "note": "Descriptive statistics of the supplied numbers."}
