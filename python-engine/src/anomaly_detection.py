"""Flags unusual numbers, gaps and stale data in a series the caller supplies.

A flag is a prompt for manual review. It is NOT proof of an error, and never proof of fraud. Missing values are reported by
position and are never filled in or treated as zero.
"""

import math

from . import financial_statistics as st
from . import validation as v

NOTE = "A flag is not proof of an error or of fraud; it only points to numbers worth checking by hand. An unusual value can be perfectly genuine."
MAX_FLAGS = 200
STALE_RUN = 5
MIN_FOR_STATISTICS = 8


def _split(values):
    if not isinstance(values, (list, tuple)):
        raise v.ValidationError("values must be a list (use null for a missing entry)")
    if len(values) < 1 or len(values) > v.MAX_POINTS:
        raise v.ValidationError(f"values must have 1 to {v.MAX_POINTS} entries")
    valid, missing = [], []
    for i, x in enumerate(values):
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x):
            missing.append(i)
        else:
            valid.append((i, float(x)))
    return valid, missing


def _robust_z(data):
    """(median, scale, z-scores). scale comes from the MAD, or the mean absolute deviation when the MAD is zero."""
    med = st.median(data)
    mad = st.median([abs(x - med) for x in data])
    if mad > 0:
        return med, mad / 0.6745, [(x - med) / (mad / 0.6745) for x in data]
    mean_abs = math.fsum(abs(x - med) for x in data) / len(data)
    if mean_abs > 0:
        return med, mean_abs * 1.2533, [(x - med) / (mean_abs * 1.2533) for x in data]
    return med, 0.0, [0.0 for _ in data]


def detect_anomalies(values, threshold=3.5, expect_non_negative=False, check_changes=True):
    """Level outliers, sudden jumps, missing entries, stale (repeated) values and unexpected negatives."""
    valid, missing = _split(values)
    thr = v.number(threshold, "threshold", 2, 10)
    if not isinstance(expect_non_negative, bool) or not isinstance(check_changes, bool):
        raise v.ValidationError("expect_non_negative and check_changes must be true or false")
    flags = []

    if missing:
        flags.append({"index": missing[0], "value": None, "type": "missing_values", "severity": "medium",
                      "explanation": f"{len(missing)} entries are missing or not numbers (first at position {missing[0]}). "
                                     "They were not filled in or treated as zero.",
                      "positions": missing[:50]})

    if expect_non_negative:
        for i, x in valid:
            if x < 0:
                flags.append({"index": i, "value": x, "type": "unexpected_negative", "severity": "high",
                              "explanation": "A negative value where only zero or positive numbers were expected."})

    run_start = None
    for k in range(len(valid) + 1):
        same = k < len(valid) and run_start is not None and valid[k][1] == valid[run_start][1] and \
            valid[k][0] == valid[k - 1][0] + 1
        if same:
            continue
        if run_start is not None and k - run_start >= STALE_RUN:
            flags.append({"index": valid[run_start][0], "value": valid[run_start][1], "type": "stale_repeated_value",
                          "severity": "low",
                          "explanation": f"The same value repeats {k - run_start} times in a row; the feed may be stuck."})
        run_start = k if k < len(valid) else None

    statistics_note = None
    if len(valid) >= MIN_FOR_STATISTICS:
        data = [x for _, x in valid]
        med, scale, zs = _robust_z(data)
        if scale > 0:
            for (i, x), z in zip(valid, zs):
                if abs(z) > thr:
                    flags.append({"index": i, "value": x, "type": "level_outlier",
                                  "severity": "high" if abs(z) > 2 * thr else "medium", "robust_z_score": z,
                                  "explanation": f"Far from the typical value (median {med:.6g}); robust score {z:.1f}."})
        if check_changes:
            changes, where = [], []
            for a in range(1, len(valid)):
                (i0, x0), (i1, x1) = valid[a - 1], valid[a]
                if i1 == i0 + 1 and x0 != 0:
                    changes.append((x1 - x0) / abs(x0) * 100.0)
                    where.append((i1, x1, x0))
            if len(changes) >= MIN_FOR_STATISTICS:
                cmed, cscale, czs = _robust_z(changes)
                if cscale > 0:
                    for (i, x1, x0), c, z in zip(where, changes, czs):
                        if abs(z) > thr:
                            flags.append({"index": i, "value": x1, "type": "sudden_change",
                                          "severity": "high" if abs(z) > 2 * thr else "medium", "robust_z_score": z,
                                          "explanation": f"Changed {c:.2f}% from the previous value ({x0:.6g}), "
                                                         f"unusual compared with the typical change of {cmed:.2f}%."})
    else:
        statistics_note = f"Only {len(valid)} usable values; at least {MIN_FOR_STATISTICS} are needed for outlier statistics."

    order = {"high": 0, "medium": 1, "low": 2}
    flags.sort(key=lambda f: (order[f["severity"]], f["index"]))
    total = len(flags)
    out = {
        "entries": len(valid) + len(missing),
        "usable_values": len(valid),
        "missing_count": len(missing),
        "flag_count": total,
        "flags": flags[:MAX_FLAGS],
        "flags_truncated": total > MAX_FLAGS,
        "threshold": thr,
        "note": NOTE,
    }
    if statistics_note:
        out["statistics_note"] = statistics_note
    return out
