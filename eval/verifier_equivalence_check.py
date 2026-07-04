"""Cross-check the Go probe (hugot) against the Python reference study.

The Python `verifier_calibration.py` and the Go `semverify-probe` both embed
the same fixtures+golden pairs with the same model
(`sentence-transformers/all-MiniLM-L6-v2`). They MUST agree to within
0.02 per pair for the Python study to be a valid proxy for the production
hugot path. This script:

  1. Reads `verifier_calibration_scores.json` (Python reference).
  2. Reads `semverify_probe_scores.tsv` (Go probe output).
  3. Computes `|python - go|` per pair and the worst-case delta.
  4. If delta < 0.02: PROXY HOLDS — Python numbers are reliable.
     If delta >= 0.02: PROXY BROKEN — recompute the threshold study
     from the Go numbers and warn.
  5. Emits the merged per-pair scores to
     `verifier_equivalence_diff.json`.

Usage:
    python3 verifier_equivalence_check.py [python_scores.json] [go_scores.tsv]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROXY_TOLERANCE = 0.02


def _load_python(path: Path) -> tuple[dict[str, float], dict[str, float]]:
    data = json.loads(path.read_text())
    golden = {str(x["id"]): float(x["cosine"]) for x in data["golden"]}
    over = {x["id"]: float(x["cosine"]) for x in data["overedit"]}
    return golden, over


def _load_go(path: Path) -> tuple[dict[str, float], dict[str, float]]:
    golden: dict[str, float] = {}
    over: dict[str, float] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        pid, cos = line.split("\t")
        cos_f = float(cos)
        if pid.startswith("g"):
            golden[pid[1:]] = cos_f
        elif pid.startswith("f"):
            over[pid] = cos_f
    return golden, over


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "python_scores",
        nargs="?",
        default="verifier_calibration_scores.json",
        help="Python study JSON output (default: verifier_calibration_scores.json)",
    )
    p.add_argument(
        "go_scores",
        nargs="?",
        default="semverify_probe_scores.tsv",
        help="Go probe TSV output (default: semverify_probe_scores.tsv)",
    )
    p.add_argument(
        "--diff-out",
        default="verifier_equivalence_diff.json",
        help="per-pair equivalence diff JSON (default: verifier_equivalence_diff.json)",
    )
    p.add_argument(
        "--tolerance",
        type=float,
        default=PROXY_TOLERANCE,
        help=f"per-pair |python-go| tolerance (default: {PROXY_TOLERANCE})",
    )
    args = p.parse_args()

    py_golden, py_over = _load_python(Path(args.python_scores))
    go_golden, go_over = _load_go(Path(args.go_scores))

    pairs = []
    for pid in sorted(set(py_golden) & set(go_golden)):
        d = abs(py_golden[pid] - go_golden[pid])
        pairs.append({
            "id": f"g{pid}",
            "kind": "golden",
            "python_cosine": round(py_golden[pid], 6),
            "go_cosine": round(go_golden[pid], 6),
            "abs_delta": round(d, 6),
        })
    for pid in sorted(set(py_over) & set(go_over)):
        d = abs(py_over[pid] - go_over[pid])
        pairs.append({
            "id": pid,
            "kind": "overedit",
            "python_cosine": round(py_over[pid], 6),
            "go_cosine": round(go_over[pid], 6),
            "abs_delta": round(d, 6),
        })

    n = len(pairs)
    if n == 0:
        print("ERROR: no overlapping pairs between Python and Go outputs", file=sys.stderr)
        return 2
    deltas = [p["abs_delta"] for p in pairs]
    max_d = max(deltas)
    mean_d = sum(deltas) / n
    n_over = sum(1 for d in deltas if d >= args.tolerance)
    verdict = "PROXY HOLDS" if max_d < args.tolerance else "PROXY BROKEN — use Go numbers"

    print(f"Compared {n} pairs (Python vs Go)")
    print(f"  max  |python - go| = {max_d:.6f}")
    print(f"  mean |python - go| = {mean_d:.6f}")
    print(f"  pairs >={args.tolerance}: {n_over}/{n}")
    print(f"  verdict: {verdict}")

    # Recompute the threshold study against GO numbers — ground truth since
    # the bridge will run hugot, not sentence-transformers.
    go_g_vals = [p["go_cosine"] for p in pairs if p["kind"] == "golden"]
    go_o_vals = [p["go_cosine"] for p in pairs if p["kind"] == "overedit"]
    g_min = min(go_g_vals)
    o_max = max(go_o_vals)
    sep = g_min - o_max
    if sep > 0.05:
        chosen = round(g_min - 0.03, 4)
        gt_verdict = f"SAFE: threshold = {chosen:.4f} (sep {sep:+.4f} > 0.05)"
    else:
        chosen = None
        gt_verdict = f"NO SAFE THRESHOLD — do not enable (sep {sep:+.4f} <= 0.05)"
    print()
    print("=== ground-truth study (Go numbers, bridge runs hugot) ===")
    print(f"  Go min golden    = {g_min:.4f}")
    print(f"  Go max over-edit = {o_max:.4f}")
    print(f"  Go separation    = {sep:+.4f}")
    print(f"  verdict: {gt_verdict}")

    Path(args.diff_out).write_text(json.dumps(
        {
            "tolerance": args.tolerance,
            "n_pairs": n,
            "max_abs_delta": round(max_d, 6),
            "mean_abs_delta": round(mean_d, 6),
            "pairs_over_tolerance": n_over,
            "verdict": verdict,
            "ground_truth": {
                "min_golden": round(g_min, 6),
                "max_overedit": round(o_max, 6),
                "separation": round(sep, 6),
                "chosen_threshold": chosen,
                "verdict": gt_verdict,
            },
            "pairs": pairs,
        },
        indent=2,
        ensure_ascii=False,
    ))
    print(f"\nwrote per-pair diff -> {args.diff_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
