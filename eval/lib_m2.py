"""Shared M2 helpers for the benchmark runners.

read_m2_sources: extract the source sentences (the `S ` lines) from an M2 file,
in order. detokenize: best-effort PTB-detokenizer to recover natural text from a
tokenized M2 S-line (BEA/ERRANT wants natural text; CoNLL wants the tokens as-is
so it does NOT use this).
"""

import re


def read_m2_sources(path: str) -> list[str]:
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("S "):
                out.append(line[2:].rstrip("\n"))
    return out


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
