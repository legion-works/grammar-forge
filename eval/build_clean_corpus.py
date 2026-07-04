#!/usr/bin/env python3
"""Build eval/clean_corpus.jsonl: known-clean sentences the bridge must NOT flag.

Sources:
  1. golden.jsonl "golden" outputs — correct by definition (125 sentences, deduped).
  2. AUTHORED — hand-written sentences covering registers golden lacks:
     casual chat, technical prose, British spellings.

Usage: python3 build_clean_corpus.py [golden.jsonl] [clean_corpus.jsonl]
"""

import json
import sys

# (sentence, register) — authored for this corpus; extend freely, keep clean.
AUTHORED: list[tuple[str, str]] = [
    # casual (Discord/Slack-style, informal but grammatical)
    ("lol that was actually hilarious", "casual"),
    ("gonna grab lunch, back in twenty", "casual"),
    ("ok so the plan is movies at eight, then pizza", "casual"),
    ("nah I'm good, thanks though", "casual"),
    ("tbh the second season was way better", "casual"),
    ("can't make it tonight, raincheck?", "casual"),
    ("that build finally passed, huge relief", "casual"),
    ("brb, someone's at the door", "casual"),
    ("same tbh", "casual"),
    ("we should totally do this again next weekend", "casual"),
    ("no worries, take your time", "casual"),
    ("omg the cat just knocked the plant over again", "casual"),
    # technical (code-adjacent prose that must not be "corrected")
    ("The webhook retries with exponential backoff up to five times.", "technical"),
    ("Set GF_LLM_BASE_URL to point at any OpenAI-compatible endpoint.", "technical"),
    ("The cache key is a SHA-256 of the model, prompt, and sentence.", "technical"),
    ("Run docker compose up -d to start the stack.", "technical"),
    ("The parser degrades to whole-text mode for code-like input.", "technical"),
    ("Offsets are UTF-16 code units, not bytes.", "technical"),
    ("The daemon listens on port 8082 for gRPC and 8000 for REST.", "technical"),
    ("Pass --no-verify only when the hook itself is broken.", "technical"),
    ("The LRU evicts the least recently used sentence first.", "technical"),
    ("Both binaries link against the same libonnxruntime build.", "technical"),
    # british (must survive a british-dialect deploy unflagged)
    ("The colour scheme of the theatre programme was grey and silver.", "british"),
    ("We organised the neighbourhood litter-pick for Saturday.", "british"),
    ("He apologised for the behaviour of his colleagues.", "british"),
    ("The centre aisle was blocked, so we favoured the side exits.", "british"),
    ("She realised the cheque had already been cancelled.", "british"),
    ("Our labour costs rose after the licence fees doubled.", "british"),
    ("The catalogue lists every flavour we stock.", "british"),
    ("They travelled north to analyse the harbour defences.", "british"),
]


def derive_golden_outputs(golden_path: str) -> list[dict]:
    rows: list[dict] = []
    seen: set[str] = set()
    with open(golden_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line)
            text = case["golden"].strip()
            if text and text not in seen:
                seen.add(text)
                rows.append(
                    {"id": f"g{len(rows) + 1:03d}", "register": "golden", "text": text}
                )
    return rows


def build(golden_path: str, out_path: str) -> int:
    rows = derive_golden_outputs(golden_path)
    for i, (text, register) in enumerate(AUTHORED, start=1):
        rows.append({"id": f"a{i:03d}", "register": register, "text": text})
    with open(out_path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


if __name__ == "__main__":
    golden = sys.argv[1] if len(sys.argv) > 1 else "golden.jsonl"
    out = sys.argv[2] if len(sys.argv) > 2 else "clean_corpus.jsonl"
    n = build(golden, out)
    print(f"wrote {n} clean sentences -> {out}")
