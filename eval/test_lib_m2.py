from lib_m2 import (
    apply_m2_edits,
    detokenize,
    parse_m2_edit,
    read_m2_annotated,
    read_m2_sources,
)


def test_read_m2_sources_extracts_s_lines(tmp_path):
    m2 = tmp_path / "x.m2"
    m2.write_text(
        "S The quick fox .\n"
        "A 1 2|||R:OTHER|||fast|||REQUIRED|||-NONE-|||0\n"
        "\n"
        "S He go home .\n"
        "A 1 2|||R:VERB|||goes|||REQUIRED|||-NONE-|||0\n\n"
    )
    assert read_m2_sources(str(m2)) == ["The quick fox .", "He go home ."]


def test_detokenize_basic():
    assert detokenize("He said , `` hi '' .") == 'He said, "hi".'
    assert detokenize("It 's a test .") == "It's a test."


def test_parse_m2_edit():
    e = parse_m2_edit("A 1 2|||R:VERB:SVA|||goes|||REQUIRED|||-NONE-|||0\n")
    assert e == {
        "start": 1,
        "end": 2,
        "type": "R:VERB:SVA",
        "repl": "goes",
        "annotator": 0,
    }


def test_apply_m2_edits_replacement():
    toks = "He go home .".split()
    edits = [parse_m2_edit("A 1 2|||R:VERB:SVA|||goes|||REQUIRED|||-NONE-|||0")]
    assert apply_m2_edits(toks, edits) == "He goes home ."


def test_apply_m2_edits_deletion_and_insertion():
    # "She very happy ." -> delete "very" (an insertion example: -NONE- means empty repl)
    toks = "She very happy .".split()
    edits = [parse_m2_edit("A 1 2|||U:ADV|||-NONE-|||REQUIRED|||-NONE-|||0")]
    assert apply_m2_edits(toks, edits) == "She happy ."
    # insertion: start==end, repl has tokens
    toks2 = "She happy .".split()
    edits2 = [parse_m2_edit("A 1 1|||M:VERB|||is|||REQUIRED|||-NONE-|||0")]
    assert apply_m2_edits(toks2, edits2) == "She is happy ."


def test_apply_m2_edits_noop_is_ignored():
    toks = "Everything is fine .".split()
    edits = [parse_m2_edit("A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0")]
    assert apply_m2_edits(toks, edits) == "Everything is fine ."


def test_apply_m2_edits_multiple_edits_right_to_left():
    toks = "She go to school yesterday .".split()
    edits = [
        parse_m2_edit("A 1 2|||R:VERB:SVA|||went|||REQUIRED|||-NONE-|||0"),
        parse_m2_edit("A 4 5|||R:OTHER|||-NONE-|||REQUIRED|||-NONE-|||0"),
    ]
    assert apply_m2_edits(toks, edits) == "She went to school ."


def test_read_m2_annotated_reconstructs_gold_pairs(tmp_path):
    m2 = tmp_path / "x.m2"
    m2.write_text(
        "S She go to school .\n"
        "A 1 2|||R:VERB:SVA|||goes|||REQUIRED|||-NONE-|||0\n"
        "A 1 2|||R:VERB:SVA|||went|||REQUIRED|||-NONE-|||1\n"
        "\n"
        "S Everything is fine .\n"
        "A -1 -1|||noop|||-NONE-|||REQUIRED|||-NONE-|||0\n\n"
    )
    pairs0 = read_m2_annotated(str(m2), annotator=0)
    assert pairs0 == [
        ("She go to school .", "She goes to school ."),
        ("Everything is fine .", "Everything is fine ."),
    ]
    pairs1 = read_m2_annotated(str(m2), annotator=1)
    assert pairs1[0] == ("She go to school .", "She went to school .")


def test_read_m2_annotated_no_edit_line_for_annotator(tmp_path):
    # sentence has an annotator-1 edit only; annotator 0 has no A line at all
    m2 = tmp_path / "x.m2"
    m2.write_text(
        "S She go to school .\nA 1 2|||R:VERB:SVA|||went|||REQUIRED|||-NONE-|||1\n\n"
    )
    pairs0 = read_m2_annotated(str(m2), annotator=0)
    assert pairs0 == [("She go to school .", "She go to school .")]
