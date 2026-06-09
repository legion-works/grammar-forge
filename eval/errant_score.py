#!/usr/bin/env python3
"""ERRANT span-level P/R/F0.5 over eval/results.json.

Exact-match (run_eval.py) is too coarse for GEC: it gives zero credit for a
sentence that fixes 2 of 3 errors, and no credit for a valid alternative
phrasing. ERRANT is the canonical GEC metric — it aligns original->hypothesis
into minimal edits and scores them against original->gold edits, reporting
precision/recall/F0.5 (F0.5 weights precision 2x, the GEC standard).

Workflow:
    python3 eval/run_eval.py            # produces eval/results.json
    eval/.venv/bin/python eval/errant_score.py

Setup (uv; .venv is gitignored):
    cd eval && uv venv && uv pip install errant "click<8.2" && \
        .venv/bin/python -m spacy download en_core_web_sm
    # The "click<8.2" pin is required: typer (pulled in transitively) dropped the
    # click shim that spaCy 3.8's `spacy download` CLI still imports.
"""

import json
from collections import defaultdict
from pathlib import Path

import errant

HERE = Path(__file__).parent
results = json.loads((HERE / "results.json").read_text())
annotator = errant.load("en")


def edit_set(orig: str, cor: str) -> set:
    """ERRANT minimal edits (o_start, o_end, c_str) for orig->cor, sans noop."""
    o = annotator.parse(orig)
    c = annotator.parse(cor)
    return {
        (e.o_start, e.o_end, e.c_str)
        for e in annotator.annotate(o, c)
        if e.type != "noop"
    }


def prf(tp: int, fp: int, fn: int):
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    beta2 = 0.25  # F0.5
    f05 = ((1 + beta2) * p * r / (beta2 * p + r)) if (beta2 * p + r) else 0.0
    return p, r, f05


def main() -> int:
    tp = fp = fn = 0
    bycat = defaultdict(lambda: [0, 0, 0])  # tp, fp, fn
    for r in results:
        if "got" not in r:
            continue
        ref = edit_set(r["input"], r["golden"])
        hyp = edit_set(r["input"], r["got"])
        t, f, n = len(ref & hyp), len(hyp - ref), len(ref - hyp)
        tp += t
        fp += f
        fn += n
        c = bycat[r["cat"]]
        c[0] += t
        c[1] += f
        c[2] += n

    p, r, f05 = prf(tp, fp, fn)
    print("=" * 66)
    print(
        f"ERRANT span-level   P={p:.3f}  R={r:.3f}  F0.5={f05:.3f}"
        f"   (TP={tp} FP={fp} FN={fn})"
    )
    print("=" * 66)
    print("Per-category (F0.5):")
    for cat in sorted(bycat):
        t, f, n = bycat[cat]
        cp, cr, cf = prf(t, f, n)
        print(
            f"  {cat:11s} F0.5={cf:.2f}  P={cp:.2f} R={cr:.2f}  (TP={t} FP={f} FN={n})"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
