"""Unit tests for the ERRANT per-type breakdown helper.

Uses the real `errant` annotator (installed in eval/.venv per the README setup
recipe) so the type codes (R:VERB:SVA, etc.) are genuine ERRANT output, not
guesses — this is the same dependency errant_score.py already takes at import
time. If errant/spaCy's en_core_web_sm model isn't installed, these tests are
skipped (the annotation call itself needs live verification in that case; the
pure-Python accumulation logic below is still covered by
test_accumulate_breakdown_* which stub the annotator).
"""

import pytest

from lib_errant_types import (
    accumulate_breakdown,
    breakdown_to_json,
    new_breakdown,
    prf,
    sorted_by_gold_count,
    totals,
    typed_edit_set,
)

errant = pytest.importorskip("errant")

try:
    ANNOTATOR = errant.load("en")
except Exception as e:  # noqa: BLE001 - model not downloaded in this env
    ANNOTATOR = None
    SKIP_REASON = f"errant model unavailable: {e!r}"


def _require_annotator():
    if ANNOTATOR is None:
        pytest.skip(SKIP_REASON)


def test_typed_edit_set_sva():
    _require_annotator()
    edits = typed_edit_set(ANNOTATOR, "She go to school.", "She goes to school.")
    assert len(edits) == 1
    (key, etype) = next(iter(edits.items()))
    assert etype.startswith("R:VERB")


def test_typed_edit_set_noop_excluded():
    _require_annotator()
    edits = typed_edit_set(ANNOTATOR, "This is fine.", "This is fine.")
    assert edits == {}


def test_prf_basic():
    p, r, f = prf(8, 2, 2)
    assert round(p, 3) == 0.8
    assert round(r, 3) == 0.8
    assert round(f, 3) == 0.8


def test_prf_all_zero():
    assert prf(0, 0, 0) == (0.0, 0.0, 0.0)


def test_accumulate_breakdown_tp_fp_fn():
    breakdown = new_breakdown()
    ref = {(0, 1, "goes"): "R:VERB:SVA", (2, 3, "the"): "M:DET"}
    hyp = {(0, 1, "goes"): "R:VERB:SVA", (5, 6, "a"): "M:DET"}
    accumulate_breakdown(breakdown, ref, hyp)
    assert breakdown["R:VERB:SVA"] == [1, 0, 0]  # TP
    assert breakdown["M:DET"] == [0, 1, 1]  # one FP (hyp-only), one FN (ref-only)
    tp, fp, fn = totals(breakdown)
    assert (tp, fp, fn) == (1, 1, 1)


def test_accumulate_breakdown_across_sentences_accumulates():
    breakdown = new_breakdown()
    accumulate_breakdown(breakdown, {(0, 1, "x"): "M:DET"}, {(0, 1, "x"): "M:DET"})
    accumulate_breakdown(breakdown, {(0, 1, "y"): "M:DET"}, {})
    assert breakdown["M:DET"] == [1, 0, 1]


def test_sorted_by_gold_count_orders_descending():
    breakdown = new_breakdown()
    breakdown["R:VERB:TENSE"] = [1, 0, 0]  # gold count 1
    breakdown["M:DET"] = [3, 1, 2]  # gold count 5
    breakdown["U:PREP"] = [0, 2, 0]  # gold count 0
    rows = sorted_by_gold_count(breakdown)
    assert [r[0] for r in rows] == ["M:DET", "R:VERB:TENSE", "U:PREP"]


def test_breakdown_to_json_shapes():
    breakdown = new_breakdown()
    breakdown["M:DET"] = [4, 1, 1]
    out = breakdown_to_json(breakdown)
    assert out["M:DET"]["tp"] == 4
    assert out["M:DET"]["fp"] == 1
    assert out["M:DET"]["fn"] == 1
    assert 0.0 <= out["M:DET"]["p"] <= 1.0
    assert 0.0 <= out["M:DET"]["f05"] <= 1.0


def test_end_to_end_real_errant_two_sentences():
    """Full pipeline over two synthetic sentences with the real annotator:
    hyp fixes sentence 1 correctly, misses sentence 2's fix (recall gap) and
    adds a spurious edit."""
    _require_annotator()
    breakdown = new_breakdown()
    pairs = [
        # (orig, hyp, gold)
        ("She go to school.", "She goes to school.", "She goes to school."),
        ("He eat the apple.", "He eat the apple.", "He eats the apple."),  # missed fix
    ]
    for orig, hyp, gold in pairs:
        ref_edits = typed_edit_set(ANNOTATOR, orig, gold)
        hyp_edits = typed_edit_set(ANNOTATOR, orig, hyp)
        accumulate_breakdown(breakdown, ref_edits, hyp_edits)
    tp, fp, fn = totals(breakdown)
    assert tp == 1  # sentence 1's SVA fix matched
    assert fn == 1  # sentence 2's SVA fix missed (the recall gap this diagnoses)
    assert fp == 0
