"""Per-edit correctness oracle for GEC suggestions.

Replaces the old ±10-byte-tolerance heuristic (which called ANY small edit
"correct", including an empty-replacement deletion the golden text never
wanted) with a distance-reduction test: an edit is correct iff APPLYING it
moves the text strictly closer to golden. This is span-shape-agnostic — a
whole-token replacement ("go"->"goes" over span (0,2)) and a minimal insert
("" -> "es" at span (2,2)) that land on the same resulting text are both
judged correct, because correctness is about the resulting text, not about
matching some canonical opcode shape.
"""

from difflib import SequenceMatcher


def edit_distance(a: str, b: str) -> int:
    """Plain character-level Levenshtein distance (stdlib-only DP; inputs are
    sentence-sized so O(len(a)*len(b)) is fine)."""
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la

    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        curr = [i] + [0] * lb
        ca = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            curr[j] = min(
                prev[j] + 1,  # deletion
                curr[j - 1] + 1,  # insertion
                prev[j - 1] + cost,  # substitution
            )
        prev = curr
    return prev[lb]


def apply_edit(input_text: str, start: int, end: int, replacement: str) -> str:
    """Apply one byte-span edit to input_text (spans are byte offsets into
    the UTF-8 encoding — the bridge's convention; decode after splicing)."""
    b = bytearray(input_text.encode("utf-8"))
    b[start:end] = replacement.encode("utf-8")
    return b.decode("utf-8", errors="replace")


def edit_is_correct(input_text: str, golden_text: str, sugg: dict) -> bool:
    """True iff applying the suggestion moves the text strictly toward the
    golden: edit_distance(apply_edit(...), golden) < edit_distance(input,
    golden). Span-shape-agnostic by construction (see module docstring). A
    deletion that golden doesn't want increases (or does not decrease)
    distance -> incorrect, so the empty-replacement always-true bug cannot
    occur under a distance test."""
    span = sugg["span"]
    after = apply_edit(input_text, span["start"], span["end"], sugg["replacement"])
    before_dist = edit_distance(input_text, golden_text)
    after_dist = edit_distance(after, golden_text)
    return after_dist < before_dist


def golden_edit_spans(input_text: str, golden_text: str) -> list[dict]:
    """DIAGNOSTIC ONLY — never used for correctness. Byte-span edits that
    transform input into golden, derived from character-level
    SequenceMatcher opcodes (char offsets converted to byte offsets via
    len(s[:i].encode('utf-8'))). Returns [{'start','end','replacement'}] per
    non-'equal' opcode, logged per case so the reliability table can drill
    into WHERE an incorrect edit landed."""
    matcher = SequenceMatcher(None, input_text, golden_text)
    spans = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        spans.append(
            {
                "start": len(input_text[:i1].encode("utf-8")),
                "end": len(input_text[:i2].encode("utf-8")),
                "replacement": golden_text[j1:j2],
            }
        )
    return spans
