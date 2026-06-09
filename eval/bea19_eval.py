#!/usr/bin/env python3
"""BEA-2019 W&I+LOCNESS dev eval via ERRANT (F0.5), comparable to published GEC
numbers. ERRANT re-tokenizes internally, so the source is fed as DETOKENIZED
natural text and the SAME source goes to errant_parallel -orig (so hyp.m2 S-lines
align with the gold m2). Data is gitignored; run eval/get_benchmarks.sh first.

Usage: python3 eval/bea19_eval.py [bridge_url] [n]
"""

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
BEA = HERE / "benchmarks" / "bea19"
GOLD = BEA / "ABCN.dev.gold.bea19.m2"
VENV_PY = HERE / ".venv" / "bin" / "python"
BRIDGE = "http://127.0.0.1:8000"
LIMIT = None

REFERENCE_TABLE = [
    ("GECToR (single, RoBERTa)", 72.4, "Omelianchuk 2020"),
    ("GECToR (ensemble)", 73.6, "Omelianchuk 2020"),
    ("GECToR-large (ensemble)", 76.05, "Tarnavskyi 2022"),
    ("T5-11B", 75.88, "Rothe 2021"),
]


def correct(text):
    body = json.dumps({"text": text, "source": "bea19"}).encode()
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


def bea_sources():
    """Natural-text source for BEA dev. Prefer the W&I+LOCNESS JSON source if
    present; else detokenize the gold-M2 S-lines. The SAME text is used for
    /correct AND errant_parallel -orig so the hyp.m2 aligns with the gold m2."""
    from lib_m2 import detokenize, read_m2_sources

    jsons = list(BEA.rglob("*.dev.json"))
    if jsons:
        out = []
        for jf in sorted(jsons):
            for line in jf.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    out.append(json.loads(line)["text"])
        # JSON is per-DOCUMENT; sentence segmentation must match the M2. If the
        # counts don't match the gold M2 sentence count, FALL BACK to the M2
        # S-lines (already ERRANT-tokenized natural text). Verify in Task 5.
        gold_n = len(read_m2_sources(str(GOLD)))
        if sum(len(t.split("\n")) for t in out) != gold_n:
            return [detokenize(s) for s in read_m2_sources(str(GOLD))]
        return out
    return [detokenize(s) for s in read_m2_sources(str(GOLD))]


def parse_errant_compare_output(out: str):
    """Parse the TP/FP/FN/P/R/F0.5 data row from errant_compare stdout."""
    p = r = f = 0.0
    lines = [ln for ln in out.splitlines() if ln.strip()]
    for i, ln in enumerate(lines):
        if ln.replace("\t", " ").split()[:3] == ["TP", "FP", "FN"]:
            vals = lines[i + 1].split()
            p, r, f = float(vals[3]), float(vals[4]), float(vals[5])
            break
    return p, r, f


def main():
    global BRIDGE, LIMIT
    BRIDGE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
    LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else None
    if not GOLD.exists():
        print("Missing data. Run: bash eval/get_benchmarks.sh", file=sys.stderr)
        return 2
    sources = bea_sources()
    if LIMIT:
        sources = sources[:LIMIT]
    src_txt, hyp_txt, hyp_m2 = BEA / "src.txt", BEA / "hyp.txt", BEA / "hyp.m2"
    with (
        open(src_txt, "w", encoding="utf-8") as fs,
        open(hyp_txt, "w", encoding="utf-8") as fh,
    ):
        for src in sources:
            try:
                resp = correct(src)
                hyp = apply_suggestions(src, resp.get("suggestions") or [])
            except Exception as e:  # noqa: BLE001
                print(f"request error: {e!r}", file=sys.stderr)
                hyp = src
            fs.write(src.replace("\n", " ") + "\n")
            fh.write(hyp.replace("\n", " ") + "\n")
    subprocess.run(
        [
            str(HERE / ".venv" / "bin" / "errant_parallel"),
            "-orig",
            str(src_txt),
            "-cor",
            str(hyp_txt),
            "-out",
            str(hyp_m2),
        ],
        check=True,
    )
    ref = GOLD
    if LIMIT:
        from conll14_eval import _truncate_m2

        ref = BEA / f"gold.first{LIMIT}.m2"
        _truncate_m2(GOLD, ref, LIMIT)
    res = subprocess.run(
        [
            str(HERE / ".venv" / "bin" / "errant_compare"),
            "-hyp",
            str(hyp_m2),
            "-ref",
            str(ref),
        ],
        capture_output=True,
        text=True,
    )
    print(res.stdout)
    p, r, fscore = parse_errant_compare_output(res.stdout)
    print("=" * 60)
    print(
        f"GrammarForge  BEA-2019-dev  F0.5 = {fscore * 100:.2f}"
        f"  (P={p * 100:.2f} R={r * 100:.2f})  over {len(sources)} sents"
    )
    print("-- published reference (F0.5, ERRANT) --")
    for name, f05, srcname in REFERENCE_TABLE:
        print(f"  {name:28s} {f05:5.2f}  [{srcname}]")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
