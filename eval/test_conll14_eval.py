from conll14_eval import REFERENCE_TABLE, gold_correction_pairs, parse_m2scorer_output


def test_parse_m2scorer_output():
    out = "Precision   : 0.7234\nRecall      : 0.4011\nF_0.5       : 0.6312\n"
    p, r, f = parse_m2scorer_output(out)
    assert (round(p, 4), round(r, 4), round(f, 4)) == (0.7234, 0.4011, 0.6312)


def test_reference_table_has_known_systems():
    names = {row[0] for row in REFERENCE_TABLE}
    assert "GECToR (single, RoBERTa)" in names


def test_gold_correction_pairs_reconstructs_and_detokenizes(tmp_path):
    """Synthetic PTB-tokenized M2 fixture standing in for the gitignored
    (non-redistributable) official CoNLL-2014 gold. Proves the ERRANT-type
    breakdown's gold-correction reconstruction detokenizes both sides so it
    lines up with the natural-text hypothesis (like conll14's own de/re
    -tokenization path for the m2scorer headline number)."""
    m2 = tmp_path / "gold.m2"
    m2.write_text(
        "S This are wrong .\n"
        "A 1 2|||R:VERB:SVA|||is|||REQUIRED|||-NONE-|||0\n\n"
    )
    pairs = gold_correction_pairs(str(m2))
    assert pairs == [("This are wrong.", "This is wrong.")]
