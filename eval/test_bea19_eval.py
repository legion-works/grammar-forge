from bea19_eval import REFERENCE_TABLE, parse_errant_compare_output


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
