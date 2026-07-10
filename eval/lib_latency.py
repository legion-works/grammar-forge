"""Shared latency-percentile helper for the benchmark runners.

Every script that calls the bridge (run_eval.py, conll14_eval.py,
bea19_eval.py, jfleg_eval.py, clean_eval.py) wraps each `/correct` call in
`time.perf_counter()` and appends the elapsed seconds to a `list[float]`.
`summarize_latencies` turns that list into the p50/p95/p99/mean report that
gets printed and persisted alongside scores.
"""

import math


def _percentile(sorted_vals: list[float], pct: float) -> float:
    """Nearest-rank percentile (pct in [0, 100]) over an already-sorted list."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * (pct / 100.0)
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return sorted_vals[int(k)]
    frac = k - lo
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def summarize_latencies(latencies_s: list[float]) -> dict:
    """Returns {n, mean_ms, p50_ms, p95_ms, p99_ms, min_ms, max_ms} (all in ms,
    latencies_s given in seconds). Empty input -> all-zero dict with n=0."""
    if not latencies_s:
        return {
            "n": 0,
            "mean_ms": 0.0,
            "p50_ms": 0.0,
            "p95_ms": 0.0,
            "p99_ms": 0.0,
            "min_ms": 0.0,
            "max_ms": 0.0,
        }
    vals = sorted(latencies_s)
    return {
        "n": len(vals),
        "mean_ms": round(1000 * sum(vals) / len(vals), 2),
        "p50_ms": round(1000 * _percentile(vals, 50), 2),
        "p95_ms": round(1000 * _percentile(vals, 95), 2),
        "p99_ms": round(1000 * _percentile(vals, 99), 2),
        "min_ms": round(1000 * vals[0], 2),
        "max_ms": round(1000 * vals[-1], 2),
    }


def format_latency_line(summary: dict) -> str:
    if summary["n"] == 0:
        return "Latency: n/a (no timed requests)"
    return (
        f"Latency (n={summary['n']}): mean={summary['mean_ms']:.1f}ms "
        f"p50={summary['p50_ms']:.1f}ms p95={summary['p95_ms']:.1f}ms "
        f"p99={summary['p99_ms']:.1f}ms min={summary['min_ms']:.1f}ms "
        f"max={summary['max_ms']:.1f}ms"
    )
