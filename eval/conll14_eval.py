#!/usr/bin/env python3
"""CoNLL-2014-test eval via the official M2 scorer (F0.5), comparable to
published GEC numbers. The M2 S-lines are PTB-tokenized; we de-tokenize them
via lib_m2.detokenize before submitting to /correct (a real client sends
natural text, not PTB tokens), then re-PTB-tokenize the hypothesis via
nltk.word_tokenize so the m2scorer comparison stays token-level. The gold
side is unchanged. Data + scorer are gitignored; run
eval/get_benchmarks.sh first.

Also reports an ERRANT per-error-type P/R/F0.5 breakdown (M:DET, R:VERB:TENSE,
U:PREP, ...) alongside the headline m2scorer number: m2scorer's own CoNLL
error-type taxonomy (ArtOrDet, Nn, SVA, Vform, Wci, ...) isn't broken out by
P/R anywhere in this harness, and it's a different taxonomy from ERRANT's
operation+type codes used everywhere else in this repo (golden set, BEA-19).
We re-annotate source->hypothesis and source->gold-correction (reconstructed
from the M2's own edit lines via lib_m2.read_m2_annotated, same idea as the
BEA-19 instrument fix) with the installed errant, and diff edit sets bucketed
by ERRANT type — see lib_errant_types.py. This is the diagnostic for "which
error types carry CoNLL's 48.5% recall gap".

Run with eval/.venv/bin/python (needs nltk + errant).

Usage: python3 eval/conll14_eval.py [bridge_url] [n]
"""

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from lib_latency import format_latency_line, summarize_latencies
from lib_m2 import detokenize

try:
    from nltk.tokenize import word_tokenize
except LookupError:
    import nltk

    nltk.download("punkt", quiet=True)
    nltk.download("punkt_tab", quiet=True)
    from nltk.tokenize import word_tokenize

HERE = Path(__file__).parent
GOLD = HERE / "benchmarks" / "conll14" / "official-2014.combined.m2"
M2SCORER = HERE / "benchmarks" / "m2scorer" / "m2scorer"
RESULTS_FILE = HERE / "benchmarks" / "conll14" / "conll14_results.json"
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


def gold_correction_pairs(path, annotator: int = 0):
    """[(detokenized_source, detokenized_gold_correction), ...] reconstructed
    from the M2's own edit lines — feeds the ERRANT per-type breakdown, which
    needs gold CORRECTED TEXT (not just the M2 edit spans) to re-annotate with
    errant the same way the hypothesis side is annotated."""
    from lib_m2 import read_m2_annotated

    pairs = read_m2_annotated(path, annotator=annotator)
    return [(detokenize(src), detokenize(cor)) for src, cor in pairs]


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
    gc_pairs = gold_correction_pairs(str(GOLD))
    if LIMIT:
        sources = sources[:LIMIT]
        gc_pairs = gc_pairs[:LIMIT]
    sysout = HERE / "benchmarks" / "conll14" / "system.txt"
    latencies = []
    request_errors = 0
    natural_hyps = []
    with open(sysout, "w", encoding="utf-8") as f:
        for src in sources:
            natural = detokenize(src)  # what a real client would actually type
            t0 = time.perf_counter()
            try:
                resp = correct(natural)
                hyp = apply_suggestions(natural, resp.get("suggestions") or [])
            except Exception as e:  # noqa: BLE001
                print(f"request error: {e!r}", file=sys.stderr)
                hyp = natural
                request_errors += 1
            latencies.append(time.perf_counter() - t0)
            natural_hyps.append(hyp)
            hyp_tokenized = " ".join(word_tokenize(hyp))
            f.write(hyp_tokenized.replace("\n", " ") + "\n")
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

    # ERRANT per-error-type breakdown (task 2) — see module docstring.
    breakdown_json = {}
    try:
        import errant

        from lib_errant_types import (
            accumulate_breakdown,
            breakdown_to_json,
            format_breakdown_table,
            new_breakdown,
        )
        from lib_errant_types import typed_edit_set as _typed

        ann = errant.load("en")
        breakdown = new_breakdown()
        for (src, gold_cor), hyp in zip(gc_pairs, natural_hyps):
            ref_edits = _typed(ann, src, gold_cor)
            hyp_edits = _typed(ann, src, hyp)
            accumulate_breakdown(breakdown, ref_edits, hyp_edits)
        print(format_breakdown_table(breakdown))
        breakdown_json = breakdown_to_json(breakdown)
    except Exception as e:  # noqa: BLE001 - breakdown is a diagnostic extra
        print(f"(per-type breakdown unavailable: {e!r})", file=sys.stderr)

    lat_summary = summarize_latencies(latencies)
    print(format_latency_line(lat_summary))

    print("=" * 60)
    print(
        f"GrammarForge  CoNLL-2014-test  F0.5 = {fscore * 100:.2f}"
        f"  (P={p * 100:.2f} R={r * 100:.2f})  over {len(sources)} sents"
    )
    print("-- published reference (F0.5, M2) --")
    for name, f05, src in REFERENCE_TABLE:
        print(f"  {name:28s} {f05:5.1f}  [{src}]")
    print(
        "(note: our golden-set 0.979 is NOT comparable; THIS is the comparable number."
        " The ERRANT-type breakdown above is a SEPARATE diagnostic diff — same idea"
        " as bea19_eval.py's instrument fix — used only to localize the recall gap,"
        " NOT to replace the m2scorer headline number.)"
    )
    print("=" * 60)

    RESULTS_FILE.write_text(
        json.dumps(
            {
                "benchmark": "conll14-test",
                "n_sentences": len(sources),
                "limit": LIMIT,
                "p": p,
                "r": r,
                "f05": fscore,
                "request_errors": request_errors,
                "latency": lat_summary,
                "by_error_type": breakdown_json,
            },
            indent=2,
        )
    )
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
