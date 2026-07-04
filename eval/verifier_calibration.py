"""Semantic verifier threshold calibration study (Phase C, Task C4).

Embeds every golden (input, golden) pair plus every over-edit fixture pair
with the same MiniLM model the bridge uses (sentence-transformers/all-MiniLM-
L6-v2), computes cosine similarity per pair, prints the distribution bounds,
and recommends a verifier threshold with a real-gap safety margin.

The chosen threshold MUST lie strictly between max(over_edit) and
min(golden) — if it does not, the bridge cannot safely enable the verifier
and this script prints `NO SAFE THRESHOLD — do not enable` and exits 1.

Usage:
    python3 verifier_calibration.py [golden.jsonl] [overedit_fixtures.jsonl]

Outputs:
    verifier_calibration_scores.json  per-pair cosine for the Go probe diff
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np


# HuggingFace caches under /home/<user>/.cache by default. On this host
# that path is owned by root (a previous root install), so route everything
# to a project-local cache the current user can write to before importing
# sentence_transformers.
_HF_CACHE = Path(__file__).resolve().parent / ".huggingface_cache"
_HF_CACHE.mkdir(exist_ok=True)
os.environ.setdefault("HF_HOME", str(_HF_CACHE))
os.environ.setdefault("HF_HUB_CACHE", str(_HF_CACHE / "hub"))
os.environ.setdefault("TRANSFORMERS_CACHE", str(_HF_CACHE))

from sentence_transformers import SentenceTransformer  # noqa: E402


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / ((np.linalg.norm(a) * np.linalg.norm(b)) or 1.0))


def _percentile(values: list[float], pct: float) -> float:
    return float(np.percentile(values, pct))


def load_jsonl(path: str) -> list[dict]:
    out: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "golden",
        nargs="?",
        default="golden.jsonl",
        help="golden.jsonl with (input, golden) pairs (default: golden.jsonl)",
    )
    parser.add_argument(
        "fixtures",
        nargs="?",
        default="overedit_fixtures.jsonl",
        help="overedit_fixtures.jsonl with (original, overedited) pairs (default: overedit_fixtures.jsonl)",
    )
    parser.add_argument(
        "--scores-out",
        default="verifier_calibration_scores.json",
        help="per-pair scores JSON (default: verifier_calibration_scores.json)",
    )
    parser.add_argument(
        "--model",
        default="sentence-transformers/all-MiniLM-L6-v2",
        help="HF model id (default: sentence-transformers/all-MiniLM-L6-v2)",
    )
    args = parser.parse_args()

    golden = load_jsonl(args.golden)
    fixtures = load_jsonl(args.fixtures)
    print(
        f"loaded {len(golden)} golden pairs, {len(fixtures)} over-edit fixtures",
        flush=True,
    )

    model = SentenceTransformer(args.model)
    print(f"loaded model {args.model!r} (dim={model.get_embedding_dimension()})", flush=True)

    # Golden pairs: similarity(input, golden) — each MUST score above the threshold.
    golden_inputs = [row["input"] for row in golden]
    golden_targets = [row["golden"] for row in golden]
    embeddings = model.encode(
        golden_inputs + golden_targets,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    n = len(golden_inputs)
    golden_scores: list[dict] = []
    for i, row in enumerate(golden):
        sim = _cosine(embeddings[i], embeddings[n + i])
        golden_scores.append({"id": row.get("id", i), "score": sim, "kind": "golden"})

    # Over-edit fixtures: similarity(original, overedited) — each MUST score below the threshold.
    orig = [r["original"] for r in fixtures]
    over = [r["overedited"] for r in fixtures]
    embeddings2 = model.encode(
        orig + over,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    over_scores: list[dict] = []
    for i, row in enumerate(fixtures):
        sim = _cosine(embeddings2[i], embeddings2[len(orig) + i])
        over_scores.append({"id": i, "score": sim, "kind": "overedit"})

    g_vals = [s["score"] for s in golden_scores]
    o_vals = [s["score"] for s in over_scores]
    g_min = min(g_vals)
    g_p5 = _percentile(g_vals, 5)
    o_max = max(o_vals)
    o_p95 = _percentile(o_vals, 95)
    sep = g_min - o_max

    print()
    print("=== golden pairs (input -> golden, must be HIGH) ===")
    print(f"  N        = {len(g_vals)}")
    print(f"  min      = {g_min:.4f}")
    print(f"  p5       = {g_p5:.4f}")
    print(f"  mean     = {sum(g_vals)/len(g_vals):.4f}")
    print(f"  max      = {max(g_vals):.4f}")
    print("=== over-edit fixtures (original -> over-edited LLM output, must be LOW) ===")
    print(f"  N        = {len(o_vals)}")
    print(f"  max      = {o_max:.4f}")
    print(f"  p95      = {o_p95:.4f}")
    print(f"  mean     = {sum(o_vals)/len(o_vals):.4f}")
    print(f"  min      = {min(o_vals):.4f}")
    print(f"=== separation (min_golden - max_overedit) = {sep:+.4f} ===")

    # We need sep > 0.05 to call it safe (the plan's margin).
    if sep > 0.05:
        chosen = round(g_min - 0.03, 4)
        verdict = (
            f"SAFE: threshold = min(golden) - 0.03 = {chosen:.4f} "
            f"(sep {sep:+.4f} > 0.05)"
        )
        print(verdict)
        exit_code = 0
    else:
        chosen = None
        print(
            f"NO SAFE THRESHOLD — do not enable "
            f"(min_golden {g_min:.4f} - max_overedit {o_max:.4f} = {sep:+.4f} <= 0.05)"
        )
        exit_code = 1

    # Persist per-pair scores for the Go probe equivalence diff.
    scores_path = Path(args.scores_out)
    with open(scores_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": args.model,
                "golden": [
                    {"id": s["id"], "cosine": round(s["score"], 6), "kind": "golden"}
                    for s in golden_scores
                ],
                "overedit": [
                    {"id": f"f{s['id']}", "cosine": round(s["score"], 6), "kind": "overedit"}
                    for s in over_scores
                ],
                "summary": {
                    "min_golden": g_min,
                    "p5_golden": g_p5,
                    "max_overedit": o_max,
                    "p95_overedit": o_p95,
                    "separation": sep,
                    "chosen_threshold": chosen,
                },
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\nwrote per-pair scores -> {scores_path}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
