#!/usr/bin/env python3
"""Dialect matrix: run golden + clean-text-FP across TWO dialect-configured
bridge deployments (american, british) and report them SIDE BY SIDE in one
table/artifact.

Why this exists: the README's clean-text FP section says "never compare
across dialect envs" because `clean_baseline.json` was measured under british
while golden gates run under american — two numbers from two different runs,
easy to misread as regression when it's really a dialect-config difference.
This script replaces that footgun: it runs BOTH corpora against BOTH dialect
bridges in one invocation and prints one report with a column per dialect, so
a reader sees "american vs british, same code, same moment" instead of
comparing two independently-run, differently-dated numbers.

This script makes real HTTP calls to two bridge URLs (one per dialect) — it
does NOT manage docker/bridge lifecycle itself (see README's escalation-gate
recipe for spinning up a second dialect container on a different port). In an
environment with no bridge/LLM (like this sandbox), it can only be
SMOKE-TESTED with the bridge call mocked — see test_dialect_matrix.py.

Usage:
    python3 eval/dialect_matrix.py [american_url] [british_url] [golden_file] [clean_file]
      american_url  default http://127.0.0.1:8000
      british_url   default http://127.0.0.1:8001
      golden_file   default eval/golden.jsonl
      clean_file    default eval/clean_corpus.jsonl
"""

import json
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

from clean_eval import run as clean_run
from clean_eval import score_clean_results
from lib_latency import summarize_latencies

HERE = Path(__file__).parent
RESULTS_FILE = HERE / "dialect_matrix_results.json"


def correct(bridge_url, text, source="dialect_matrix"):
    body = json.dumps({"text": text, "source": source}).encode()
    req = urllib.request.Request(
        bridge_url.rstrip("/") + "/correct",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def apply_suggestions(text, suggestions):
    b = bytearray(text.encode("utf-8"))
    for s in sorted(suggestions, key=lambda x: x["span"]["start"], reverse=True):
        st, en = s["span"]["start"], s["span"]["end"]
        if st < 0 or en > len(b) or st > en:
            continue
        b[st:en] = s["replacement"].encode("utf-8")
    return b.decode("utf-8", errors="replace")


def run_golden(bridge_url, cases, correct_fn=correct):
    """Run the golden set against one bridge URL; returns a summary dict
    (NOT the full run_eval.py per-case report — this is a cross-dialect
    ROLLUP, run_eval.py/errant_score.py remain the source of truth for a
    single dialect's detailed pass/fail)."""
    by_cat = defaultdict(lambda: {"pass": 0, "total": 0})
    overall_pass = 0
    latencies = []
    for c in cases:
        t0 = time.perf_counter()
        try:
            resp = correct_fn(bridge_url, c["input"])
            got = apply_suggestions(c["input"], resp.get("suggestions") or [])
        except Exception:  # noqa: BLE001
            got = c["input"]
        latencies.append(time.perf_counter() - t0)
        ok = got == c["golden"]
        by_cat[c["cat"]]["total"] += 1
        if ok:
            by_cat[c["cat"]]["pass"] += 1
            overall_pass += 1
    n = len(cases)
    return {
        "n": n,
        "pass": overall_pass,
        "pass_rate": (overall_pass / n) if n else 0.0,
        "by_cat": {k: v for k, v in by_cat.items()},
        "latency": summarize_latencies(latencies),
    }


def run_dialect(name, bridge_url, golden_cases, clean_file, correct_fn=correct, clean_runner=clean_run):
    golden_summary = run_golden(bridge_url, golden_cases, correct_fn=correct_fn)
    clean_results = clean_runner(bridge_url, clean_file)
    clean_summary = score_clean_results(clean_results)
    return {
        "dialect": name,
        "bridge_url": bridge_url,
        "golden": golden_summary,
        "clean": clean_summary,
    }


def format_matrix(reports: list[dict]) -> str:
    lines = ["Dialect matrix — same corpora, same moment, one dialect column each:"]
    header = f"  {'metric':24s}" + "".join(f"{r['dialect']:>16s}" for r in reports)
    lines.append(header)
    lines.append(
        f"  {'golden pass-rate':24s}"
        + "".join(
            f"{r['golden']['pass']:>6d}/{r['golden']['n']:<4d} {100 * r['golden']['pass_rate']:5.1f}%"
            for r in reports
        )
    )
    lines.append(
        f"  {'clean FP-rate':24s}"
        + "".join(
            f"{r['clean']['false_positives']:>6d}/{r['clean']['total']:<4d} "
            f"{100 * r['clean']['fp_rate']:5.1f}%"
            for r in reports
        )
    )
    lines.append(
        f"  {'golden p50 latency ms':24s}"
        + "".join(f"{r['golden']['latency']['p50_ms']:>16.1f}" for r in reports)
    )
    # per-category golden pass rate, union of categories across dialects
    cats = sorted({c for r in reports for c in r["golden"]["by_cat"]})
    for cat in cats:
        row = f"  {'  cat:' + cat:24s}"
        for r in reports:
            d = r["golden"]["by_cat"].get(cat)
            row += f"{(d['pass'] if d else 0):>6d}/{(d['total'] if d else 0):<4d}      " + " " * 5
        lines.append(row.rstrip())
    return "\n".join(lines)


def main(argv=None, correct_fn=None, clean_runner=None):
    """`correct_fn`/`clean_runner` are injectable so this can be smoke-tested
    without a live bridge (see test_dialect_matrix.py); default to the real
    HTTP-calling implementations."""
    argv = sys.argv[1:] if argv is None else argv
    correct_fn = correct_fn or correct
    clean_runner = clean_runner or clean_run

    american_url = argv[0] if len(argv) > 0 else "http://127.0.0.1:8000"
    british_url = argv[1] if len(argv) > 1 else "http://127.0.0.1:8001"
    golden_file = argv[2] if len(argv) > 2 else str(HERE / "golden.jsonl")
    clean_file = argv[3] if len(argv) > 3 else str(HERE / "clean_corpus.jsonl")

    golden_cases = [
        json.loads(line)
        for line in Path(golden_file).read_text().splitlines()
        if line.strip()
    ]

    reports = [
        run_dialect(
            "american", american_url, golden_cases, clean_file,
            correct_fn=correct_fn, clean_runner=clean_runner,
        ),
        run_dialect(
            "british", british_url, golden_cases, clean_file,
            correct_fn=correct_fn, clean_runner=clean_runner,
        ),
    ]

    print("=" * 70)
    print(format_matrix(reports))
    print("=" * 70)

    RESULTS_FILE.write_text(json.dumps({"reports": reports}, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
