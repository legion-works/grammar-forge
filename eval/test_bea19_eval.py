import shutil

import pytest

from bea19_eval import (
    REFERENCE_TABLE,
    _parse_args,
    bea_source_gold_pairs,
    parse_errant_compare_output,
    regenerate_reference_m2,
)


def test_parse_errant_compare_output():
    out = (
        "=========== Span-Based Correction ============\n"
        "TP\tFP\tFN\tPrec\tRec\tF0.5\n"
        "1234\t567\t890\t0.6852\t0.5810\t0.6620\n"
        "==============================================\n"
    )
    p, r, f = parse_errant_compare_output(out)
    assert (round(p, 4), round(r, 4), round(f, 4)) == (0.6852, 0.5810, 0.6620)


def test_reference_table():
    names = {row[0] for row in REFERENCE_TABLE}
    assert "GECToR-large (ensemble)" in names


def test_parse_args_defaults():
    bridge, limit, legacy, annotator = _parse_args([])
    assert bridge == "http://127.0.0.1:8000"
    assert limit is None
    assert legacy is False
    assert annotator == 0


def test_parse_args_legacy_gold_flag():
    bridge, limit, legacy, annotator = _parse_args(
        ["http://x:8000", "50", "--legacy-gold"]
    )
    assert bridge == "http://x:8000"
    assert limit == 50
    assert legacy is True
    assert annotator == 0


def test_parse_args_annotator_flag():
    bridge, limit, legacy, annotator = _parse_args(["--annotator", "1"])
    assert annotator == 1
    assert legacy is False


def test_bea_source_gold_pairs_reconstructs_from_synthetic_m2(tmp_path, monkeypatch):
    """Synthetic small M2 fixture standing in for the gitignored ABCN dev gold
    (not fetchable/verifiable live in this sandbox — see README). Proves the
    gold-correction reconstruction (the core of the instrument fix) works."""
    import bea19_eval

    m2 = tmp_path / "ABCN.dev.gold.bea19.m2"
    m2.write_text(
        "S She go to school .\n"
        "A 1 2|||R:VERB:SVA|||goes|||REQUIRED|||-NONE-|||0\n"
        "\n"
        "S This is fine .\n"
        "A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0\n\n"
    )
    monkeypatch.setattr(bea19_eval, "GOLD", m2)
    pairs = bea_source_gold_pairs(annotator=0)
    assert pairs == [
        ("She go to school.", "She goes to school."),
        ("This is fine.", "This is fine."),
    ]


@pytest.mark.skipif(
    not shutil.which("errant_parallel"), reason="errant_parallel not installed"
)
def test_regenerate_reference_m2_produces_valid_m2(tmp_path):
    """Runs the REAL errant_parallel (same binary/version the hypothesis side
    uses) end to end on a synthetic source/gold-correction pair, proving
    hypothesis and reference go through an identical annotation pipeline."""
    pairs = [
        ("She go to school.", "She goes to school."),
        ("This is fine.", "This is fine."),
    ]
    ref_m2 = regenerate_reference_m2(pairs, tmp_path)
    assert ref_m2.exists()
    content = ref_m2.read_text(encoding="utf-8")
    assert "S She go to school ." in content or "S She go to school." in content
    # the SVA edit should show up as an ERRANT-classified edit line
    assert "goes" in content
    assert "A " in content
