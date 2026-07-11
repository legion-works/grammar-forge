from lib_edit_match import (
    apply_edit,
    edit_distance,
    edit_is_correct,
    golden_edit_spans,
)


# ---- edit_distance ----------------------------------------------------


def test_edit_distance_identical_strings_is_zero():
    assert edit_distance("hello", "hello") == 0


def test_edit_distance_empty_strings():
    assert edit_distance("", "") == 0
    assert edit_distance("", "abc") == 3
    assert edit_distance("abc", "") == 3


def test_edit_distance_single_substitution():
    assert edit_distance("cat", "cot") == 1


def test_edit_distance_insertion_and_deletion():
    assert edit_distance("cat", "cats") == 1  # insertion
    assert edit_distance("cats", "cat") == 1  # deletion


def test_edit_distance_classic_kitten_sitting():
    assert edit_distance("kitten", "sitting") == 3


# ---- apply_edit ---------------------------------------------------------


def test_apply_edit_simple_ascii_replacement():
    assert apply_edit("go to school", 0, 2, "goes") == "goes to school"


def test_apply_edit_insertion_empty_span():
    # span (2, 2): zero-width insert right after "go"
    assert apply_edit("go to school", 2, 2, "es") == "goes to school"


def test_apply_edit_deletion_empty_replacement():
    assert apply_edit("go  to school", 2, 3, "") == "go to school"


def test_apply_edit_multibyte_accented_char():
    # "café" -> byte offsets: c=0 a=1 f=2 é=3-4 (2 bytes in utf-8)
    text = "café society"
    assert len("café".encode("utf-8")) == 5  # 'é' is 2 bytes
    # replace the 2-byte 'é' (bytes 3:5) with a plain 'e'
    out = apply_edit(text, 3, 5, "e")
    assert out == "cafe society"


def test_apply_edit_multibyte_emoji():
    # emoji are 4 bytes in utf-8; splice one out
    text = "hi \U0001f600 there"
    prefix_bytes = len("hi ".encode("utf-8"))
    emoji_bytes = len("\U0001f600".encode("utf-8"))
    out = apply_edit(text, prefix_bytes, prefix_bytes + emoji_bytes, "")
    assert out == "hi  there"


# ---- edit_is_correct ------------------------------------------------------


def test_edit_is_correct_whole_token_replacement():
    sugg = {
        "span": {"start": 0, "end": 2},
        "replacement": "goes",
        "model": "m",
        "confidence": 0.9,
    }
    assert edit_is_correct("go to school", "goes to school", sugg) is True


def test_edit_is_correct_minimal_insert_same_resulting_text():
    # span-shape-agnostic: a zero-width insert that produces the identical
    # corrected text as the whole-token replacement above must ALSO be True.
    sugg = {
        "span": {"start": 2, "end": 2},
        "replacement": "es",
        "model": "m",
        "confidence": 0.9,
    }
    assert edit_is_correct("go to school", "goes to school", sugg) is True


def test_edit_is_correct_wrong_replacement_is_false():
    sugg = {
        "span": {"start": 0, "end": 2},
        "replacement": "went",
        "model": "m",
        "confidence": 0.9,
    }
    assert edit_is_correct("go to school", "goes to school", sugg) is False


def test_edit_is_correct_unwanted_deletion_is_false():
    # the empty-replacement regression case: golden does NOT want this text
    # deleted, so applying it moves AWAY from golden -> must be False (the
    # old ±10-byte heuristic would have wrongly called this "correct" because
    # small/empty edits fell within the byte-distance tolerance).
    sugg = {
        "span": {"start": 0, "end": 3},
        "replacement": "",
        "model": "m",
        "confidence": 0.9,
    }
    assert edit_is_correct("cat sat", "cat sat", sugg) is False


def test_edit_is_correct_fixes_one_of_two_errors():
    # input has two errors vs golden; an edit that fixes only one of them
    # still strictly reduces distance -> True.
    input_text = "He go to school and eated lunch"
    golden = "He goes to school and ate lunch"
    sugg = {
        "span": {"start": 3, "end": 5},
        "replacement": "goes",
        "model": "m",
        "confidence": 0.9,
    }
    assert edit_is_correct(input_text, golden, sugg) is True


def test_edit_is_correct_category_may_be_absent():
    sugg = {
        "span": {"start": 0, "end": 2},
        "replacement": "goes",
        "model": "m",
        "confidence": 0.9,
    }
    assert "category" not in sugg
    assert edit_is_correct("go to school", "goes to school", sugg) is True


# ---- golden_edit_spans ------------------------------------------------


def test_golden_edit_spans_only_non_equal_opcodes():
    spans = golden_edit_spans("go to school", "goes to school")
    assert len(spans) == 1
    assert spans[0]["replacement"] == "es"


def test_golden_edit_spans_identical_texts_no_spans():
    assert golden_edit_spans("same text", "same text") == []


def test_golden_edit_spans_multibyte_offset_correctness():
    # "café" -> replace with "cafe": the diff opcode must report BYTE offsets
    # (café is 5 bytes, plain 'e' replaces the 2-byte é at byte offset 3).
    spans = golden_edit_spans("café society", "cafe society")
    assert len(spans) == 1
    assert spans[0]["start"] == 3
    assert spans[0]["end"] == 5
    assert spans[0]["replacement"] == "e"


def test_golden_edit_spans_applies_to_reconstruct_golden():
    # sanity: applying all returned spans (last-to-first to keep offsets
    # valid) reconstructs golden from input.
    input_text = "He go to school and eated lunch"
    golden = "He goes to school and ate lunch"
    spans = golden_edit_spans(input_text, golden)
    assert len(spans) >= 1
    b = bytearray(input_text.encode("utf-8"))
    for sp in sorted(spans, key=lambda s: s["start"], reverse=True):
        b[sp["start"] : sp["end"]] = sp["replacement"].encode("utf-8")
    assert b.decode("utf-8") == golden
