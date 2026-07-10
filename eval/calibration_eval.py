#!/usr/bin/env python3
"""Confidence calibration: is the bridge's per-case `score` (0-100) an honest
probability the correction is right, or just a number?

Every row in results.json (written by run_eval.py) carries a `score` field
(0-100, from the LLM/model) and a `pass` field (exact-match correctness). This
script buckets rows by score, computes each bucket's EMPIRICAL pass rate, and
reports Expected Calibration Error (ECE) — the standard weighted-average gap
between predicted confidence and observed accuracy:

    ECE = sum_over_buckets( |bucket| / N * |accuracy(bucket) - confidence(bucket)| )

where confidence(bucket) is the mean score/100 in that bucket and
accuracy(bucket) is the fraction of rows in that bucket with pass=True.

This is the ONE benchmark in this harness you can run for real offline — it
needs no bridge/LLM call, just an existing results.json.

Usage:
    python3 eval/calibration_eval.py [results.json]   # default eval/results.json
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_RESULTS = HERE / "results.json"
DEFAULT_OUT = HERE / "calibration_results.json"

# 10-pt buckets over [0, 100]; last bucket is closed [90, 100].
N_BUCKETS = 10


def bucket_index(score: float, n_buckets: int = N_BUCKETS) -> int:
    idx = int(score // (100 / n_buckets))
    return min(idx, n_buckets - 1)  # score==100 lands in the last bucket


def build_reliability_table(rows: list[dict], n_buckets: int = N_BUCKETS) -> list[dict]:
    """[{lo, hi, n, mean_confidence, empirical_accuracy, gap}, ...] — only
    rows with both a numeric `score` and a boolean `pass` are used."""
    buckets = [[] for _ in range(n_buckets)]
    for r in rows:
        score = r.get("score")
        passed = r.get("pass")
        if score is None or passed is None:
            continue
        buckets[bucket_index(float(score), n_buckets)].append(r)

    width = 100 / n_buckets
    table = []
    for i, items in enumerate(buckets):
        lo, hi = round(i * width), round((i + 1) * width)
        if not items:
            table.append(
                {
                    "lo": lo,
                    "hi": hi,
                    "n": 0,
                    "mean_confidence": None,
                    "empirical_accuracy": None,
                    "gap": None,
                }
            )
            continue
        mean_conf = sum(r["score"] for r in items) / len(items) / 100.0
        acc = sum(1 for r in items if r["pass"]) / len(items)
        table.append(
            {
                "lo": lo,
                "hi": hi,
                "n": len(items),
                "mean_confidence": round(mean_conf, 4),
                "empirical_accuracy": round(acc, 4),
                "gap": round(abs(acc - mean_conf), 4),
            }
        )
    return table


def expected_calibration_error(table: list[dict]) -> float:
    n_total = sum(b["n"] for b in table)
    if n_total == 0:
        return 0.0
    return sum(
        (b["n"] / n_total) * b["gap"] for b in table if b["n"] > 0
    )


def format_reliability_table(table: list[dict], ece: float) -> str:
    lines = [f"Reliability table ({N_BUCKETS} buckets, score vs empirical pass rate):"]
    lines.append(f"  {'bucket':>9s} {'n':>5s} {'conf':>7s} {'acc':>7s} {'gap':>7s}")
    for b in table:
        if b["n"] == 0:
            lines.append(f"  {b['lo']:3d}-{b['hi']:<3d}   {'0':>5s}     -       -       -")
            continue
        lines.append(
            f"  {b['lo']:3d}-{b['hi']:<3d}   {b['n']:5d} "
            f"{b['mean_confidence']:7.3f} {b['empirical_accuracy']:7.3f} "
            f"{b['gap']:7.3f}"
        )
    lines.append(f"\nECE = {ece:.4f}")
    return "\n".join(lines)


def main() -> int:
    results_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_RESULTS
    if not results_path.exists():
        print(f"Missing {results_path}. Run eval/run_eval.py first.", file=sys.stderr)
        return 2
    rows = json.loads(results_path.read_text())
    table = build_reliability_table(rows)
    ece = expected_calibration_error(table)

    print("=" * 60)
    print(format_reliability_table(table, ece))
    n_scored = sum(b["n"] for b in table)
    n_total = len(rows)
    if n_scored < n_total:
        print(
            f"\n({n_total - n_scored}/{n_total} rows skipped: missing score/pass "
            "— e.g. request-error rows)"
        )
    print("=" * 60)

    DEFAULT_OUT.write_text(
        json.dumps(
            {
                "source": str(results_path),
                "n_buckets": N_BUCKETS,
                "n_rows_scored": n_scored,
                "n_rows_total": n_total,
                "reliability_table": table,
                "ece": round(ece, 4),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
