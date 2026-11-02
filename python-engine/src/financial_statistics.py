"""Plain statistics (standard library only). Units: whatever the caller passes in; functions never rescale."""

import math

from .validation import ValidationError


def mean(v):
    if not v:
        raise ValidationError("no data")
    return math.fsum(v) / len(v)


def variance(v):
    """Sample variance (n - 1). Needs at least 2 values."""
    if len(v) < 2:
        raise ValidationError("at least 2 values are needed")
    m = mean(v)
    return math.fsum((x - m) ** 2 for x in v) / (len(v) - 1)


def stdev(v):
    return math.sqrt(variance(v))


def percentile(v, p):
    """Linear interpolation between closest ranks (same rule as the Julia engine). p in [0, 100]."""
    if not v:
        raise ValidationError("no data")
    s = sorted(v)
    n = len(s)
    if n == 1:
        return s[0]
    h = (n - 1) * (p / 100.0)
    lo = int(math.floor(h))
    hi = min(lo + 1, n - 1)
    return s[lo] + (h - lo) * (s[hi] - s[lo])


def median(v):
    return percentile(v, 50)


def skewness(v):
    """Moment skewness g1; None when it is undefined (fewer than 3 values or no variation)."""
    n = len(v)
    if n < 3:
        return None
    m = mean(v)
    m2 = math.fsum((x - m) ** 2 for x in v) / n
    if m2 <= 0:
        return None
    m3 = math.fsum((x - m) ** 3 for x in v) / n
    return m3 / m2 ** 1.5


def excess_kurtosis(v):
    n = len(v)
    if n < 4:
        return None
    m = mean(v)
    m2 = math.fsum((x - m) ** 2 for x in v) / n
    if m2 <= 0:
        return None
    m4 = math.fsum((x - m) ** 4 for x in v) / n
    return m4 / m2 ** 2 - 3.0


def covariance(a, b):
    if len(a) != len(b):
        raise ValidationError("series must have the same length")
    if len(a) < 2:
        raise ValidationError("at least 2 values are needed")
    ma, mb = mean(a), mean(b)
    return math.fsum((x - ma) * (y - mb) for x, y in zip(a, b)) / (len(a) - 1)


def correlation(a, b):
    """Pearson correlation; None when either series does not vary (correlation is undefined, not zero)."""
    va, vb = variance(a), variance(b)
    if va <= 0 or vb <= 0:
        return None
    c = covariance(a, b) / math.sqrt(va * vb)
    return max(-1.0, min(1.0, c))


def summary(v):
    """Numerical summary of one series."""
    if not v:
        raise ValidationError("no data")
    out = {
        "count": len(v),
        "mean": mean(v),
        "median": median(v),
        "min": min(v),
        "max": max(v),
        "p5": percentile(v, 5),
        "p25": percentile(v, 25),
        "p75": percentile(v, 75),
        "p95": percentile(v, 95),
        "std_dev": stdev(v) if len(v) >= 2 else None,
        "skewness": skewness(v),
        "excess_kurtosis": excess_kurtosis(v),
    }
    return out
