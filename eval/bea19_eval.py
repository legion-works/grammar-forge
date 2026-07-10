#!/usr/bin/env python3
"""BEA-2019 W&I+LOCNESS dev eval via ERRANT (F0.5).

## The instrument fix (2026-07-10)

Previously this script scored the bridge's hypothesis (annotated with the
INSTALLED errant, 3.0.2) against the OFFICIAL gold m2 (annotated upstream with
errant==2.0.0, Python <=3.6 only — uninstallable in this venv). Comparing edits
produced by two different errant versions is not a like-for-like diff: 2.0.0
and 3.0.2 tokenize and classify some spans differently, so edits that are
semantically identical land in different (start, end, c_str) buckets and
score as false positives/false negatives that aren't real model errors. That
is why the committed F0.5 (14.53) was flagged STALE/uncalibrated — it was
measuring annotator drift, not the bridge.

Three fixes were on the table:
  (a) Re-annotate BOTH sides with the SAME installed errant version. The gold
      m2's `A` edit lines still carry the annotator's raw corrections, so the
      gold CORRECTED TEXT is recoverable by applying those edits to the
      tokenized source (`lib_m2.read_m2_annotated`). Re-running
      `errant_parallel` on (source, reconstructed-gold-correction) with the
      SAME errant/spaCy version and the SAME `errant_parallel` binary used for
      the hypothesis produces a reference m2 that is annotated by an
      IDENTICAL pipeline to the hypothesis m2. This is a like-for-like diff.
  (b) Pin errant==2.0.0 in a dedicated venv. Rejected: errant 2.0.0 requires
      Python <=3.6, which cannot coexist with the nltk/spaCy 3.13 venv this
      harness already depends on for CoNLL-14, and would require the owner to
      maintain a SECOND python interpreter + venv just for this one script.
      Not turnkey, and the mission is to make re-runs turnkey.
  (c) Both behind a flag. Implemented: (a) regeneration is the default (it is
      the actual fix); `--legacy-gold` reproduces the OLD, non-comparable
      behavior (scoring against the errant-2.0.0 gold m2 as-is) so the prior
      14.53 datapoint stays reproducible for historical continuity, clearly
      labeled non-comparable in its own output.

Net effect: default-mode BEA-dev F0.5 is now an apples-to-apples ERRANT
diff (same annotator version on both sides). It is STILL not bit-comparable
to the published BEA shared-task leaderboard (those numbers used errant
2.0.0 end to end, plus a possibly-different M2 gold; this harness measures
"errant-3.0.2-consistent, single-reference (annotator 0), our source
detokenization"), but it no longer contains a self-inflicted, avoidable
scoring artifact from mixed annotator versions. Treat CoNLL-2014 (m2scorer,
exact-comparable to publications) as the headline; this is now a TRUSTWORTHY
directional/diagnostic number instead of a discredited one.

Run with eval/.venv/bin/python (needs errant + nltk). Data is gitignored; run
eval/get_benchmarks.sh first.

Usage: python3 eval/bea19_eval.py [bridge_url] [n] [--legacy-gold] [--annotator N]
  --legacy-gold   score against the RAW errant-2.0.0 gold m2 (old, non
                  -comparable behavior); default is regenerated-reference mode.
  --annotator N   which BEA annotator id to reconstruct gold-correction from
                  (default 0 — BEA dev is single-reference per sentence).
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from lib_latency import format_latency_line, summarize_latencies

HERE = Path(__file__).parent
BEA = HERE / "benchmarks" / "bea19"
GOLD = BEA / "ABCN.dev.gold.bea19.m2"
VENV_PY = HERE / ".venv" / "bin" / "python"


def _resolve_tool(name: str) -> str:
    """Prefer the pinned eval/.venv copy (README's documented setup); fall
    back to PATH so the "same installed errant, both sides" invariant this
    module relies on still holds in an environment where the venv's own
    interpreter isn't usable (e.g. a CI sandbox where the venv was built by
    `uv` against a python not present on this machine, but errant is
    installed globally) — a stale venv script whose shebang python is gone
    still passes a plain file-exists check, so gate on the venv's OWN python
    resolving, not the tool script."""
    venv_python = HERE / ".venv" / "bin" / "python"
    venv_path = HERE / ".venv" / "bin" / name
    if venv_python.exists() and venv_path.exists():
        return str(venv_path)
    return shutil.which(name) or str(venv_path)


ERRANT_PARALLEL = _resolve_tool("errant_parallel")
ERRANT_COMPARE = _resolve_tool("errant_compare")
BRIDGE = "http://127.0.0.1:8000"
LIMIT = None
RESULTS_FILE = BEA / "bea19_results.json"

REFERENCE_TABLE = [
    ("GECToR (single, RoBERTa)", 72.4, "Omelianchuk 2020"),
    ("GECToR (ensemble)", 73.6, "Omelianchuk 2020"),
    ("GECToR-large (ensemble)", 76.05, "Tarnavskyi 2022"),
    ("T5-11B", 75.88, "Rothe 2021"),
]


def correct(text):
    body = json.dumps({"text": text, "source": "bea19"}).encode()
    import urllib.request

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


def bea_source_gold_pairs(annotator: int = 0):
    """[(detokenized_source, detokenized_gold_correction), ...] reconstructed
    from the M2's own edit lines for the given annotator id."""
    from lib_m2 import detokenize, read_m2_annotated

    pairs = read_m2_annotated(str(GOLD), annotator=annotator)
    return [(detokenize(src), detokenize(cor)) for src, cor in pairs]


def bea_sources():
    """Legacy accessor: detokenized source only (kept for import-compat with
    any external caller; bea_source_gold_pairs is what main() actually uses
    now so hypothesis and reference source are derived identically)."""
    return [src for src, _cor in bea_source_gold_pairs()]


def regenerate_reference_m2(pairs, work_dir: Path) -> Path:
    """Re-annotate source->gold-correction with the INSTALLED errant via
    errant_parallel (the SAME binary/version used for the hypothesis m2),
    producing a reference m2 that is pipeline-identical to the hypothesis.
    This is the BEA instrument fix: eliminates the errant-2.0.0-vs-3.0.2
    cross-version diff."""
    gold_src_txt = work_dir / "gold_src.regen.txt"
    gold_cor_txt = work_dir / "gold_cor.regen.txt"
    with (
        open(gold_src_txt, "w", encoding="utf-8") as fs,
        open(gold_cor_txt, "w", encoding="utf-8") as fc,
    ):
        for src, cor in pairs:
            fs.write(src.replace("\n", " ") + "\n")
            fc.write(cor.replace("\n", " ") + "\n")
    ref_m2 = work_dir / "gold_regenerated.m2"
    subprocess.run(
        [
            str(ERRANT_PARALLEL),
            "-orig",
            str(gold_src_txt),
            "-cor",
            str(gold_cor_txt),
            "-out",
            str(ref_m2),
        ],
        check=True,
    )
    return ref_m2


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


def _parse_args(argv):
    legacy_gold = "--legacy-gold" in argv
    argv = [a for a in argv if a != "--legacy-gold"]
    annotator = 0
    if "--annotator" in argv:
        i = argv.index("--annotator")
        annotator = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2 :]
    bridge = argv[0] if len(argv) > 0 else "http://127.0.0.1:8000"
    limit = int(argv[1]) if len(argv) > 1 else None
    return bridge, limit, legacy_gold, annotator


def main():
    global BRIDGE, LIMIT
    bridge, limit, legacy_gold, annotator = _parse_args(sys.argv[1:])
    BRIDGE = bridge.rstrip("/")
    LIMIT = limit
    if not GOLD.exists():
        print("Missing data. Run: bash eval/get_benchmarks.sh", file=sys.stderr)
        return 2

    pairs = bea_source_gold_pairs(annotator=annotator)
    if LIMIT:
        pairs = pairs[:LIMIT]
    sources = [src for src, _cor in pairs]

    src_txt, hyp_txt, hyp_m2 = BEA / "src.txt", BEA / "hyp.txt", BEA / "hyp.m2"
    latencies = []
    request_errors = 0
    with (
        open(src_txt, "w", encoding="utf-8") as fs,
        open(hyp_txt, "w", encoding="utf-8") as fh,
    ):
        for src in sources:
            t0 = time.perf_counter()
            try:
                resp = correct(src)
                hyp = apply_suggestions(src, resp.get("suggestions") or [])
            except Exception as e:  # noqa: BLE001
                print(f"request error: {e!r}", file=sys.stderr)
                hyp = src
                request_errors += 1
            latencies.append(time.perf_counter() - t0)
            fs.write(src.replace("\n", " ") + "\n")
            fh.write(hyp.replace("\n", " ") + "\n")

    subprocess.run(
        [str(ERRANT_PARALLEL), "-orig", str(src_txt), "-cor", str(hyp_txt), "-out", str(hyp_m2)],
        check=True,
    )

    if legacy_gold:
        ref = GOLD
        if LIMIT:
            from conll14_eval import _truncate_m2

            ref = BEA / f"gold.first{LIMIT}.m2"
            _truncate_m2(GOLD, ref, LIMIT)
    else:
        ref = regenerate_reference_m2(pairs, BEA)

    res = subprocess.run(
        [str(ERRANT_COMPARE), "-hyp", str(hyp_m2), "-ref", str(ref)],
        capture_output=True,
        text=True,
    )
    print(res.stdout)
    p, r, fscore = parse_errant_compare_output(res.stdout)

    # ERRANT per-error-type breakdown (task 2): re-annotate source->hyp and
    # source->gold-correction sentence-by-sentence with the same in-process
    # annotator, so the breakdown is on the SAME pipeline as the headline
    # number (regenerated-reference mode) or, in --legacy-gold mode, still
    # gives a same-version-both-sides diagnostic even though the headline
    # number in that mode is cross-version.
    breakdown_json = {}
    try:
        import errant

        from lib_errant_types import (
            accumulate_breakdown,
            breakdown_to_json,
            format_breakdown_table,
            new_breakdown,
            typed_edit_set,
        )

        ann = errant.load("en")
        hyp_lines = Path(hyp_txt).read_text(encoding="utf-8").splitlines()
        breakdown = new_breakdown()
        for (src, gold_cor), hyp in zip(pairs, hyp_lines):
            ref_edits = typed_edit_set(ann, src, gold_cor)
            hyp_edits = typed_edit_set(ann, src, hyp)
            accumulate_breakdown(breakdown, ref_edits, hyp_edits)
        print(format_breakdown_table(breakdown))
        breakdown_json = breakdown_to_json(breakdown)
    except Exception as e:  # noqa: BLE001 - breakdown is a diagnostic extra
        print(f"(per-type breakdown unavailable: {e!r})", file=sys.stderr)

    lat_summary = summarize_latencies(latencies)
    print(format_latency_line(lat_summary))

    print("=" * 60)
    mode = "LEGACY-GOLD (errant 2.0.0 vs 3.0.2, non-comparable)" if legacy_gold else "regenerated-reference (errant-version-consistent)"
    print(
        f"GrammarForge  BEA-2019-dev  F0.5 = {fscore * 100:.2f}"
        f"  (P={p * 100:.2f} R={r * 100:.2f})  over {len(sources)} sents  [{mode}]"
    )
    print("-- published reference (F0.5, ERRANT) --")
    for name, f05, srcname in REFERENCE_TABLE:
        print(f"  {name:28s} {f05:5.2f}  [{srcname}]")
    if legacy_gold:
        print(
            "NOTE: --legacy-gold mode — gold m2 is UNCHANGED errant-2.0.0 output "
            "scored against an errant-3.0.2 hypothesis. NON-COMPARABLE / historical "
            "only; kept for continuity with the prior 14.53 datapoint. Prefer the "
            "default (regenerated-reference) mode."
        )
    else:
        print(
            "NOTE: reference m2 was REGENERATED from the gold corrections with "
            "the SAME errant/errant_parallel used for the hypothesis (fixes the "
            "errant-2.0.0-vs-3.0.2 cross-version drift). Still not bit-comparable "
            "to the published BEA leaderboard (which used errant 2.0.0 end to "
            "end) — treat CoNLL-2014 (m2scorer) as the headline, this as a "
            "now-TRUSTWORTHY diagnostic/directional number."
        )
    print("=" * 60)

    RESULTS_FILE.write_text(
        json.dumps(
            {
                "benchmark": "bea19-dev",
                "mode": "legacy-gold" if legacy_gold else "regenerated-reference",
                "annotator": annotator,
                "n_sentences": len(sources),
                "limit": LIMIT,
                "p": p,
                "r": r,
                "f05": fscore,
                "request_errors": request_errors,
                "latency": lat_summary,
                "by_error_type": breakdown_json,
                "comparability_note": (
                    "regenerated-reference: errant-version-consistent both sides, "
                    "directional vs published (which used errant 2.0.0 end to end)"
                    if not legacy_gold
                    else "legacy-gold: NON-COMPARABLE, errant-2.0.0 gold vs errant-3.0.2 hyp"
                ),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
