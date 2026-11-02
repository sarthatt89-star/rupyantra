"""Input validation shared by every module. Nothing is guessed or silently repaired: bad input is refused with a clear message."""

import math

MAX_POINTS = 100_000      # values in one series
MAX_SERIES = 50           # series in one request
MAX_NAME_LENGTH = 80


class ValidationError(Exception):
    """The request is wrong (not a bug in the engine). `code` is always INVALID_INPUT."""

    code = "INVALID_INPUT"

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def number(x, name, lo=None, hi=None):
    """A finite real number (bool and text are refused) inside [lo, hi]."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise ValidationError(f"{name} must be a number")
    v = float(x)
    if not math.isfinite(v):
        raise ValidationError(f"{name} must be a finite number")
    if lo is not None and v < lo:
        raise ValidationError(f"{name} must be at least {lo}")
    if hi is not None and v > hi:
        raise ValidationError(f"{name} must be at most {hi}")
    return v


def integer(x, name, lo, hi):
    v = number(x, name, lo, hi)
    if v != int(v):
        raise ValidationError(f"{name} must be a whole number")
    return int(v)


def choice(x, name, options):
    if not isinstance(x, str) or x not in options:
        raise ValidationError(f"{name} must be one of: {', '.join(options)}")
    return x


def series(x, name, min_len=1, max_len=MAX_POINTS, lo=None, hi=None, positive=False):
    """A list of finite numbers. Missing values (None / NaN / text) are REPORTED with their position, never filled in."""
    if not isinstance(x, (list, tuple)):
        raise ValidationError(f"{name} must be a list of numbers")
    if len(x) < min_len:
        raise ValidationError(f"{name} needs at least {min_len} values (got {len(x)})")
    if len(x) > max_len:
        raise ValidationError(f"{name} has too many values (max {max_len})")
    out = []
    for i, v in enumerate(x):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValidationError(f"{name}[{i}] is missing or not a number")
        f = float(v)
        if not math.isfinite(f):
            raise ValidationError(f"{name}[{i}] is not a finite number")
        if positive and f <= 0:
            raise ValidationError(f"{name}[{i}] must be above 0")
        if lo is not None and f < lo:
            raise ValidationError(f"{name}[{i}] must be at least {lo}")
        if hi is not None and f > hi:
            raise ValidationError(f"{name}[{i}] must be at most {hi}")
        out.append(f)
    return out


def prices(x, name="prices", min_len=2):
    """Positive prices / index levels, oldest first."""
    return series(x, name, min_len=min_len, positive=True, hi=1e15)


def returns_percent(x, name="returns_percent", min_len=2):
    """Per-period returns in PERCENT (1.5 means 1.5%). A return can not be below -100%."""
    return series(x, name, min_len=min_len, lo=-100.0, hi=1e6)


def label(x, name):
    if not isinstance(x, str) or not (1 <= len(x) <= MAX_NAME_LENGTH):
        raise ValidationError(f"{name} must be text of 1 to {MAX_NAME_LENGTH} characters")
    return x
