from conll14_eval import REFERENCE_TABLE, parse_m2scorer_output


def test_parse_m2scorer_output():
    out = "Precision   : 0.7234\nRecall      : 0.4011\nF_0.5       : 0.6312\n"
    p, r, f = parse_m2scorer_output(out)
    assert (round(p, 4), round(r, 4), round(f, 4)) == (0.7234, 0.4011, 0.6312)


def test_reference_table_has_known_systems():
    names = {row[0] for row in REFERENCE_TABLE}
    assert "GECToR (single, RoBERTa)" in names
