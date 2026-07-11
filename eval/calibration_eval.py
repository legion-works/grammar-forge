#!/usr/bin/env python3
"""Confidence calibration: are the bridge's per-suggestion `confidence`
scores (0-1) honest probabilities the suggested EDIT is right, or just
numbers?

DEFAULT MODE (per-edit, Task 4): every row in results.json (written by
run_eval.py) carries a `suggestions` list — one entry per bridge-returned
edit, `{model, category, confidence, correct}` — where `correct` was decided
by lib_edit_match.edit_is_correct's distance-reduction oracle at eval time
(applying the edit must move the text strictly closer to golden). This
script flattens ALL suggestions across ALL cases into one pool, buckets them
by confidence, and computes Expected Calibration Error (ECE) — the standard
weighted-average gap between predicted confidence and observed accuracy:

    ECE = sum_over_buckets( |bucket| / N * |accuracy(bucket) - confidence(bucket)| )

where confidence(bucket) is the mean confidence in that bucket and
accuracy(bucket) is the fraction of suggestions in that bucket with
correct=True. It also breaks the same pool down into a per-(model,category)
reliability table, since a model might be well-calibrated overall while
badly over/under-confident on one category. Exact-match `pass` is NOT the
target variable in this mode — a case can have `pass=False` (didn't reach
gold) while still containing individually-correct edits, and per-edit
calibration should credit those.

PER-CASE MODE (--per-case, the original/legacy behavior): buckets whole
CASES by the bridge's per-case `score` (0-100) and computes ECE against
exact-match `pass`. Kept for backward compatibility / comparison; unchanged
behavior versus before Task 4.

This is the ONE benchmark in this harness you can run for real offline — it
needs no bridge/LLM call, just an existing results.json.

Usage:
    python3 eval/calibration_eval.py [results.json]              # per-edit (default)
    python3 eval/calibration_eval.py [results.json] --per-case   # legacy per-case mode
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).parent
DEFAULT_RESULTS = HERE / "results.json"
DEFAULT_OUT = HERE / "calibration_results.json"

# 10-pt buckets over [0, 100]; last bucket is closed [90, 100]. Used for both
# modes — per-edit confidence (0-1) is scaled to the same 0-100 axis so the
# bucketing/reporting code is shared.
N_BUCKETS = 10


def bucket_index(score: float, n_buckets: int = N_BUCKETS) -> int:
    idx = int(score // (100 / n_buckets))
    return min(idx, n_buckets - 1)  # score==100 lands in the last bucket


def _bucketize(items, score_of, pass_of, n_buckets: int = N_BUCKETS) -> list[dict]:
    """Shared bucketing core: `score_of`/`pass_of` extract a 0-100 score and
    a boolean from each item (returning None skips the item — e.g. missing
    score/pass, or missing confidence/correct)."""
    buckets = [[] for _ in range(n_buckets)]
    for item in items:
        score = score_of(item)
        passed = pass_of(item)
        if score is None or passed is None:
            continue
        buckets[bucket_index(float(score), n_buckets)].append((score, passed))

    width = 100 / n_buckets
    table = []
    for i, bucket_items in enumerate(buckets):
        lo, hi = round(i * width), round((i + 1) * width)
        if not bucket_items:
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
        mean_conf = sum(s for s, _ in bucket_items) / len(bucket_items) / 100.0
        acc = sum(1 for _, p in bucket_items if p) / len(bucket_items)
        table.append(
            {
                "lo": lo,
                "hi": hi,
                "n": len(bucket_items),
                "mean_confidence": round(mean_conf, 4),
                "empirical_accuracy": round(acc, 4),
                "gap": round(abs(acc - mean_conf), 4),
            }
        )
    return table


def build_reliability_table(rows: list[dict], n_buckets: int = N_BUCKETS) -> list[dict]:
    """PER-CASE mode. [{lo, hi, n, mean_confidence, empirical_accuracy, gap},
    ...] — only rows with both a numeric `score` and a boolean `pass` are
    used."""
    return _bucketize(
        rows, lambda r: r.get("score"), lambda r: r.get("pass"), n_buckets
    )


def extract_all_suggestions(rows: list[dict]) -> tuple[list[dict], int]:
    """PER-EDIT mode. Flattens every row's `suggestions` list (written by
    run_eval.py's build_suggestion_detail) into one pool across all cases.
    Rows missing the `suggestions` field entirely (old results.json written
    before Task 4) are skipped rather than erroring. Returns (suggestions,
    n_rows_skipped)."""
    suggestions = []
    n_skipped = 0
    for r in rows:
        if "suggestions" not in r:
            n_skipped += 1
            continue
        suggestions.extend(r["suggestions"])
    return suggestions, n_skipped


def build_edit_reliability_table(
    suggestions: list[dict], n_buckets: int = N_BUCKETS
) -> list[dict]:
    """PER-EDIT mode. Same [{lo, hi, n, mean_confidence, empirical_accuracy,
    gap}, ...] shape as build_reliability_table, bucketed by each
    suggestion's `confidence` (0-1, scaled to 0-100 for bucketing) against
    its `correct` flag. Suggestions with a missing confidence/correct are
    skipped."""
    return _bucketize(
        suggestions,
        lambda s: None if s.get("confidence") is None else s["confidence"] * 100,
        lambda s: s.get("correct"),
        n_buckets,
    )


def build_model_category_table(suggestions: list[dict]) -> list[dict]:
    """PER-EDIT mode. [{model, category, n, mean_confidence,
    empirical_accuracy, gap}, ...] grouped by (model, category), sorted for
    stable output. Category "" means grammar suggestions (bridge omits the
    field for those)."""
    groups = defaultdict(list)
    for s in suggestions:
        conf, correct = s.get("confidence"), s.get("correct")
        if conf is None or correct is None:
            continue
        groups[(s.get("model"), s.get("category", ""))].append((conf, correct))

    table = []
    for (model, category), items in sorted(
        groups.items(), key=lambda kv: (kv[0][0] or "", kv[0][1] or "")
    ):
        n = len(items)
        mean_conf = sum(c for c, _ in items) / n
        acc = sum(1 for _, ok in items if ok) / n
        table.append(
            {
                "model": model,
                "category": category,
                "n": n,
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
    return sum((b["n"] / n_total) * b["gap"] for b in table if b["n"] > 0)


def _format_bucket_lines(table: list[dict]) -> list[str]:
    lines = [f"  {'bucket':>9s} {'n':>5s} {'conf':>7s} {'acc':>7s} {'gap':>7s}"]
    for b in table:
        if b["n"] == 0:
            lines.append(
                f"  {b['lo']:3d}-{b['hi']:<3d}   {'0':>5s}     -       -       -"
            )
            continue
        lines.append(
            f"  {b['lo']:3d}-{b['hi']:<3d}   {b['n']:5d} "
            f"{b['mean_confidence']:7.3f} {b['empirical_accuracy']:7.3f} "
            f"{b['gap']:7.3f}"
        )
    return lines


def format_reliability_table(table: list[dict], ece: float) -> str:
    lines = [f"Reliability table ({N_BUCKETS} buckets, score vs empirical pass rate):"]
    lines.extend(_format_bucket_lines(table))
    lines.append(f"\nECE = {ece:.4f}")
    return "\n".join(lines)


def format_edit_reliability_table(table: list[dict], ece: float) -> str:
    lines = [
        f"Per-edit reliability table ({N_BUCKETS} buckets, "
        "confidence vs empirical correctness):"
    ]
    lines.extend(_format_bucket_lines(table))
    lines.append(f"\nECE = {ece:.4f}")
    return "\n".join(lines)


def format_model_category_table(table: list[dict]) -> str:
    if not table:
        return "Per-(model,category) reliability: (no suggestions)"
    lines = ["Per-(model,category) reliability:"]
    lines.append(
        f"  {'model':>12s} {'category':>10s} {'n':>5s} {'conf':>7s} {'acc':>7s} {'gap':>7s}"
    )
    for row in table:
        lines.append(
            f"  {str(row['model']):>12s} {str(row['category'] or '-'):>10s} "
            f"{row['n']:5d} {row['mean_confidence']:7.3f} "
            f"{row['empirical_accuracy']:7.3f} {row['gap']:7.3f}"
        )
    return "\n".join(lines)


def _parse_args(argv=None) -> tuple[Path, bool]:
    parser = argparse.ArgumentParser()
    parser.add_argument("results_path", nargs="?", default=None)
    parser.add_argument(
        "--per-case",
        action="store_true",
        default=False,
        help="legacy mode: bucket whole cases by score vs exact-match pass",
    )
    ns = parser.parse_args(argv)
    results_path = Path(ns.results_path) if ns.results_path else DEFAULT_RESULTS
    return results_path, ns.per_case


def _run_per_case(rows: list[dict], results_path: Path) -> dict:
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

    return {
        "mode": "per-case",
        "source": os.path.relpath(results_path, start=HERE),
        "n_buckets": N_BUCKETS,
        "n_rows_scored": n_scored,
        "n_rows_total": n_total,
        "reliability_table": table,
        "ece": round(ece, 4),
    }


def _run_per_edit(rows: list[dict], results_path: Path) -> dict:
    suggestions, n_rows_skipped = extract_all_suggestions(rows)
    table = build_edit_reliability_table(suggestions)
    ece = expected_calibration_error(table)
    model_category_table = build_model_category_table(suggestions)

    print("=" * 60)
    print(format_edit_reliability_table(table, ece))
    n_scored = sum(b["n"] for b in table)
    n_suggestions = len(suggestions)
    if n_scored < n_suggestions:
        print(
            f"\n({n_suggestions - n_scored}/{n_suggestions} suggestions skipped: "
            "missing confidence/correct)"
        )
    if n_rows_skipped:
        print(
            f"({n_rows_skipped}/{len(rows)} rows skipped: missing 'suggestions' "
            "field — old results.json predating per-edit recording)"
        )
    print()
    print(format_model_category_table(model_category_table))
    print("=" * 60)

    return {
        "mode": "per-edit",
        "source": os.path.relpath(results_path, start=HERE),
        "n_buckets": N_BUCKETS,
        "n_rows_total": len(rows),
        "n_rows_skipped_missing_suggestions": n_rows_skipped,
        "n_suggestions_total": n_suggestions,
        "n_suggestions_scored": n_scored,
        "reliability_table": table,
        "model_category_table": model_category_table,
        "ece": round(ece, 4),
    }


def main(argv=None) -> int:
    results_path, per_case = _parse_args(argv)
    if not results_path.exists():
        print(f"Missing {results_path}. Run eval/run_eval.py first.", file=sys.stderr)
        return 2
    rows = json.loads(results_path.read_text())

    out = (
        _run_per_case(rows, results_path)
        if per_case
        else _run_per_edit(rows, results_path)
    )

    DEFAULT_OUT.write_text(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
