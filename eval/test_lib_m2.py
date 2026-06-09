from lib_m2 import read_m2_sources, detokenize


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
