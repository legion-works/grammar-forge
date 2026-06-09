#!/usr/bin/env python3
"""CoNLL-2014-test eval via the official M2 scorer (F0.5), comparable to
published GEC numbers. Source is PRE-TOKENIZED — fed to /correct as-is; output
stays token-per-space (m2scorer is token-level). Data + scorer are gitignored;
run eval/get_benchmarks.sh first.

Usage: python3 eval/conll14_eval.py [bridge_url] [n]
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
GOLD = HERE / "benchmarks" / "conll14" / "official-2014.combined.m2"
M2SCORER = HERE / "benchmarks" / "m2scorer" / "m2scorer"
BRIDGE = "http://127.0.0.1:8000"
LIMIT = None

# Published CoNLL-2014-test F0.5 (M2) for context (system, F0.5, source).
REFERENCE_TABLE = [
    ("GECToR (single, RoBERTa)", 65.3, "Omelianchuk 2020"),
    ("GECToR (ensemble)", 66.5, "Omelianchuk 2020"),
    ("GECToR-large (ensemble)", 65.3, "Tarnavskyi 2022"),
    ("T5-11B", 68.9, "Rothe 2021"),
]


def correct(text):  # same pattern as jfleg_eval.py
    body = json.dumps({"text": text, "source": "conll14"}).encode()
    req = urllib.request.Request(
        BRIDGE + "/correct", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def apply_suggestions(text, suggestions):  # verbatim from jfleg_eval.py
    b = bytearray(text.encode("utf-8"))
    for s in sorted(suggestions, key=lambda x: x["span"]["start"], reverse=True):
        st, en = s["span"]["start"], s["span"]["end"]
        if st < 0 or en > len(b) or st > en:
            continue
        b[st:en] = s["replacement"].encode("utf-8")
    return b.decode("utf-8", errors="replace")


def read_sources(path):
    from lib_m2 import read_m2_sources

    return read_m2_sources(path)


def parse_m2scorer_output(out: str):
    p = r = f = 0.0
    for line in out.splitlines():
        if line.startswith("Precision"):
            p = float(line.split(":")[1])
        elif line.startswith("Recall"):
            r = float(line.split(":")[1])
        elif line.startswith("F_0.5") or line.startswith("F0.5"):
            f = float(line.split(":")[1])
    return p, r, f


def main():
    global BRIDGE, LIMIT
    BRIDGE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
    LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else None
    if not GOLD.exists() or not M2SCORER.exists():
        print("Missing data/scorer. Run: bash eval/get_benchmarks.sh", file=sys.stderr)
        return 2
    sources = read_sources(str(GOLD))
    if LIMIT:
        sources = sources[:LIMIT]
    sysout = HERE / "benchmarks" / "conll14" / "system.txt"
    with open(sysout, "w", encoding="utf-8") as f:
        for src in sources:
            try:
                resp = correct(src)
                hyp = apply_suggestions(src, resp.get("suggestions") or [])
            except Exception as e:  # noqa: BLE001
                print(f"request error: {e!r}", file=sys.stderr)
                hyp = src
            f.write(hyp.replace("\n", " ") + "\n")
    # m2scorer scores the first LIMIT sentences only if we also subset the gold;
    # for a true number run the FULL set (LIMIT=None). For a subset, build a
    # truncated gold copy.
    gold = GOLD
    if LIMIT:
        gold = HERE / "benchmarks" / "conll14" / f"gold.first{LIMIT}.m2"
        _truncate_m2(GOLD, gold, LIMIT)
    res = subprocess.run(
        [str(M2SCORER), str(sysout), str(gold)], capture_output=True, text=True
    )
    print(res.stdout)
    p, r, fscore = parse_m2scorer_output(res.stdout)
    print("=" * 60)
    print(
        f"GrammarForge  CoNLL-2014-test  F0.5 = {fscore * 100:.2f}"
        f"  (P={p * 100:.2f} R={r * 100:.2f})  over {len(sources)} sents"
    )
    print("-- published reference (F0.5, M2) --")
    for name, f05, src in REFERENCE_TABLE:
        print(f"  {name:28s} {f05:5.1f}  [{src}]")
    print(
        "(note: our golden-set 0.979 is NOT comparable; THIS is the comparable number)"
    )
    print("=" * 60)
    return 0


def _truncate_m2(src_path, dst_path, n):
    """Copy the first n sentence-blocks (S + A lines, blank-separated) of an M2."""
    blocks, cur = [], []
    for line in Path(src_path).read_text(encoding="utf-8").splitlines():
        if line == "" and cur:
            blocks.append(cur)
            cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append(cur)
    with open(dst_path, "w", encoding="utf-8") as f:
        for blk in blocks[:n]:
            f.write("\n".join(blk) + "\n\n")


if __name__ == "__main__":
    raise SystemExit(main())
