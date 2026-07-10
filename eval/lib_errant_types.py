"""Shared ERRANT per-error-type P/R/F0.5 breakdown for the academic benchmarks.

errant_score.py already buckets TP/FP/FN by the golden set's own hand-authored
`cat` tag (sva, tense, article, ...). This module buckets by ERRANT's OWN
operation+type code instead (M:DET, R:VERB:TENSE, U:PREP, ...) — the
finer-grained taxonomy ERRANT assigns from its own POS/dependency
classification of each edit. That is THE diagnostic for "which error types
carry the recall gap": conll14_eval.py and bea19_eval.py both need it because
neither m2scorer nor errant_compare reports per-type P/R on their own.

Design: for a given (orig, hyp) and (orig, gold) pair, independently compute
ERRANT's minimal edit set for each (mirroring errant_score.py's `edit_set`),
but keep each edit's `type` alongside its (o_start, o_end, c_str) key. Matching
for TP/FP/FN is by (o_start, o_end, c_str) same as errant_score.py; the type
used to bucket a TP is the gold edit's type (ERRANT's classification is a
deterministic function of the (orig, cor) span pair, so a TP's hyp-side type
matches its gold-side type by construction). FP buckets use the hyp edit's own
type; FN buckets use the gold edit's own type.

The annotator is injected (rather than imported at module scope) so callers
share ONE spaCy-backed annotator across many sentences, and so tests can stub
it out without a real spaCy model.
"""

from collections import defaultdict


def typed_edit_set(annotator, orig: str, cor: str) -> dict:
    """{(o_start, o_end, c_str): type} for orig->cor, excluding `noop`."""
    o = annotator.parse(orig)
    c = annotator.parse(cor)
    return {
        (e.o_start, e.o_end, e.c_str): e.type
        for e in annotator.annotate(o, c)
        if e.type != "noop"
    }


def prf(tp: int, fp: int, fn: int) -> tuple:
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    beta2 = 0.25  # F0.5
    f05 = ((1 + beta2) * p * r / (beta2 * p + r)) if (beta2 * p + r) else 0.0
    return p, r, f05


def accumulate_breakdown(breakdown: dict, ref_edits: dict, hyp_edits: dict) -> None:
    """Add one sentence's ref/hyp typed edit sets into a running
    `breakdown[type] = [tp, fp, fn]` dict (mutated in place)."""
    ref_keys = set(ref_edits)
    hyp_keys = set(hyp_edits)
    for key in ref_keys & hyp_keys:
        breakdown[ref_edits[key]][0] += 1  # tp
    for key in hyp_keys - ref_keys:
        breakdown[hyp_edits[key]][1] += 1  # fp
    for key in ref_keys - hyp_keys:
        breakdown[ref_edits[key]][2] += 1  # fn


def new_breakdown() -> dict:
    return defaultdict(lambda: [0, 0, 0])


def totals(breakdown: dict) -> tuple:
    tp = sum(v[0] for v in breakdown.values())
    fp = sum(v[1] for v in breakdown.values())
    fn = sum(v[2] for v in breakdown.values())
    return tp, fp, fn


def sorted_by_gold_count(breakdown: dict) -> list:
    """[(type, tp, fp, fn), ...] sorted by descending gold-edit count (tp+fn),
    the count that matters for "where does recall leak" — per the task brief."""
    rows = [(t, tp, fp, fn) for t, (tp, fp, fn) in breakdown.items()]
    rows.sort(key=lambda row: (row[1] + row[3]), reverse=True)
    return rows


def breakdown_to_json(breakdown: dict) -> dict:
    """JSON-serializable {type: {tp, fp, fn, p, r, f05}}, for persisting into
    a results file."""
    out = {}
    for t, (tp, fp, fn) in breakdown.items():
        p, r, f05 = prf(tp, fp, fn)
        out[t] = {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "p": round(p, 4),
            "r": round(r, 4),
            "f05": round(f05, 4),
        }
    return out


def format_breakdown_table(breakdown: dict) -> str:
    lines = ["Per-error-type (ERRANT, sorted by gold-edit count):"]
    lines.append(f"  {'type':16s} {'gold':>5s} {'tp':>5s} {'fp':>5s} {'fn':>5s} "
                  f"{'P':>6s} {'R':>6s} {'F0.5':>6s}")
    for t, tp, fp, fn in sorted_by_gold_count(breakdown):
        p, r, f05 = prf(tp, fp, fn)
        gold = tp + fn
        lines.append(
            f"  {t:16s} {gold:5d} {tp:5d} {fp:5d} {fn:5d} "
            f"{p:6.3f} {r:6.3f} {f05:6.3f}"
        )
    return "\n".join(lines)
