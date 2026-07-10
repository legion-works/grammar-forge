"""Shared M2 helpers for the benchmark runners.

read_m2_sources: extract the source sentences (the `S ` lines) from an M2 file,
in order. detokenize: best-effort PTB-detokenizer to recover natural text from a
tokenized M2 S-line (BEA/ERRANT wants natural text; CoNLL wants the tokens as-is
so it does NOT use this).

parse_m2_edit / apply_m2_edits / read_m2_annotated: reconstruct the GOLD
corrected text from an M2 file's `A` (edit) lines. This lets a caller
re-derive "source -> gold-corrected" natural-text pairs from a tokenized M2,
which is what both the BEA-19 reference-regeneration fix (bea19_eval.py) and
the ERRANT error-type breakdown (conll14_eval.py, bea19_eval.py) need: they
re-annotate source->gold-corrected with the SAME errant version used for
source->hypothesis, instead of trusting the M2's own (possibly differently
-annotated) edit types.
"""

import re


def read_m2_sources(path: str) -> list[str]:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("S "):
                out.append(line[2:].rstrip("\n"))
    return out


def parse_m2_edit(line: str) -> dict:
    """Parse one M2 `A` line: 'A start end|||type|||replacement|||REQUIRED|||-NONE-|||annotator'."""
    body = line[2:].rstrip("\n")
    span, etype, repl, _req, _coder, annot = body.split("|||")
    start_s, end_s = span.split()
    return {
        "start": int(start_s),
        "end": int(end_s),
        "type": etype,
        "repl": repl,
        "annotator": int(annot),
    }


def apply_m2_edits(tokens: list[str], edits: list[dict]) -> str:
    """Apply a list of parsed M2 edits (single annotator, `noop` filtered) to a
    tokenized source-sentence token list, returning the corrected sentence as a
    tokenized string (space-joined — matches the M2's own tokenization; caller
    detokenizes for natural text). Edits are applied right-to-left so earlier
    offsets stay valid."""
    toks = list(tokens)
    for e in sorted(edits, key=lambda e: e["start"], reverse=True):
        if e["type"] == "noop":
            continue
        repl_toks = [] if e["repl"] == "-NONE-" else e["repl"].split()
        toks[e["start"] : e["end"]] = repl_toks
    return " ".join(toks)


def read_m2_annotated(path: str, annotator: int = 0) -> list[tuple[str, str]]:
    """Return [(source_line, corrected_line), ...] (both tokenized, space-joined)
    for the given annotator id, applying only that annotator's edits to the
    tokenized source. Sentences with no edit line for `annotator` (or only a
    `noop`) reconstruct to the source unchanged."""
    pairs: list[tuple[str, str]] = []
    src_line = None
    edits: list[dict] = []

    def flush():
        if src_line is not None:
            cor = apply_m2_edits(src_line.split(), edits)
            pairs.append((src_line, cor))

    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if line.startswith("S "):
                flush()
                src_line = line[2:]
                edits = []
            elif line.startswith("A "):
                e = parse_m2_edit(line)
                if e["annotator"] == annotator:
                    edits.append(e)
    flush()
    return pairs


# Minimal PTB detokenizer (enough for BEA source recovery). For higher fidelity
# the plan allows swapping in sacremoses; this stdlib version avoids a new dep.
def detokenize(text: str) -> str:
    s = f" {text} "
    s = s.replace(" `` ", ' "').replace(" '' ", '" ')
    s = re.sub(r" ([.,;:!?%])", r"\1", s)
    s = re.sub(r" n't", "n't", s)
    s = re.sub(r" '(s|re|ve|d|ll|m)\b", r"'\1", s)
    s = s.replace(" ( ", " (").replace(" ) ", ") ")
    s = re.sub(r"\(\s+", "(", s)
    s = re.sub(r"\s+\)", ")", s)
    return s.strip()
