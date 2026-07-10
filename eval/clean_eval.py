#!/usr/bin/env python3
"""Clean-text false-positive eval: every sentence in the corpus is known-clean;
ANY suggestion returned by /correct is a false positive (deliberately stricter
than run_eval.py's applied-text-differs check — a suggestion on clean text is a
user-visible underline even when applying it would be a no-op).

Usage: python3 clean_eval.py [bridge_url] [corpus_file] [--max-fp-rate PCT]
                              [--runs N] [--out FILE]
Exit 0 when fp_rate <= --max-fp-rate (default 100 = report-only), else 1.

--runs N (default 1): repeat the FULL corpus run N times and report
mean +/- stdev and min/max per metric (fp_rate, plus flagged counts per
register/model/category), instead of a single-run point estimate. LLM
sampling is stochastic — a lone run has no error bars. The --max-fp-rate
gate, when --runs > 1, is applied to the MEAN fp_rate across runs.
All individual runs are persisted (not just the aggregate) to --out
(default <corpus_stem>.runs.json) so a spike in one run is inspectable.
"""

import argparse
import json
import statistics
import sys
import time
import urllib.request
from pathlib import Path

from lib_latency import format_latency_line, summarize_latencies


def score_clean_results(results: list[dict]) -> dict:
    by_register: dict[str, dict[str, int]] = {}
    by_model: dict[str, int] = {}
    by_category: dict[str, int] = {}
    fp = 0
    for r in results:
        if "error" in r:
            continue  # measurement failure, not a clean-text result
        reg = by_register.setdefault(r["register"], {"total": 0, "fp": 0})
        reg["total"] += 1
        if r["flagged"]:
            fp += 1
            reg["fp"] += 1
            for m in r["models"]:
                by_model[m] = by_model.get(m, 0) + 1
            for c in r["categories"]:
                by_category[c] = by_category.get(c, 0) + 1
    total = sum(1 for r in results if "error" not in r)
    return {
        "total": total,
        "false_positives": fp,
        "fp_rate": (fp / total) if total else 0.0,
        "by_register": by_register,
        "by_model": by_model,
        "by_category": by_category,
    }


def run(bridge_url: str, corpus_file: str) -> list[dict]:
    results: list[dict] = []
    with open(corpus_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            case = json.loads(line)
            t0 = time.perf_counter()
            try:
                req = urllib.request.Request(
                    f"{bridge_url}/correct",
                    data=json.dumps(
                        {"text": case["text"], "source": "languagetool"}
                    ).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 - operator-supplied local bridge URL
                    body = json.load(resp)
                latency_ms = round((time.perf_counter() - t0) * 1000, 2)
                suggestions = body.get("suggestions") or []
                results.append(
                    {
                        "id": case["id"],
                        "register": case["register"],
                        "flagged": bool(suggestions),
                        "models": [s.get("model", "?") for s in suggestions],
                        "categories": [
                            s.get("category") or "grammar" for s in suggestions
                        ],
                        "text": case["text"],
                        "suggestions": suggestions,
                        "latency_ms": latency_ms,
                    }
                )
            except Exception as e:
                latency_ms = round((time.perf_counter() - t0) * 1000, 2)
                print(f"  WARN: {case['id']} request failed: {e!r}", file=sys.stderr)
                results.append(
                    {
                        "id": case["id"],
                        "register": case["register"],
                        "flagged": False,
                        "models": [],
                        "categories": [],
                        "text": case["text"],
                        "suggestions": [],
                        "error": repr(e),
                        "latency_ms": latency_ms,
                    }
                )
    return results


def _latency_summary_for(results: list[dict]) -> dict:
    secs = [r["latency_ms"] / 1000 for r in results if "latency_ms" in r]
    return summarize_latencies(secs)


def _mean_stdev_min_max(vals: list[float]) -> dict:
    return {
        "mean": round(statistics.mean(vals), 4) if vals else 0.0,
        "stdev": round(statistics.stdev(vals), 4) if len(vals) > 1 else 0.0,
        "min": round(min(vals), 4) if vals else 0.0,
        "max": round(max(vals), 4) if vals else 0.0,
    }


def aggregate_runs(run_summaries: list[dict]) -> dict:
    """mean/stdev/min/max of fp_rate across N repeated full-corpus runs (task 5:
    LLM sampling is stochastic, a single run has no confidence interval)."""
    fp_rates = [s["fp_rate"] for s in run_summaries]
    return {
        "n_runs": len(run_summaries),
        "fp_rate": _mean_stdev_min_max(fp_rates),
        "false_positives": _mean_stdev_min_max(
            [s["false_positives"] for s in run_summaries]
        ),
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("bridge_url", nargs="?", default="http://127.0.0.1:8000")
    p.add_argument("corpus_file", nargs="?", default="clean_corpus.jsonl")
    p.add_argument(
        "--max-fp-rate",
        type=float,
        default=100.0,
        help="max acceptable FP rate in PERCENT; default 100 = report-only",
    )
    p.add_argument(
        "--runs",
        type=int,
        default=1,
        help="repeat the full corpus run N times; report mean +/- stdev, min/max",
    )
    p.add_argument(
        "--out",
        default=None,
        help="persist all runs to this JSON file (default <corpus_stem>.runs.json)",
    )
    args = p.parse_args()

    out_path = Path(
        args.out or (Path(args.corpus_file).with_suffix("").name + ".runs.json")
    )

    all_results = []  # list of per-run result lists
    run_summaries = []  # list of per-run score_clean_results() dicts
    latency_summaries = []
    for run_idx in range(args.runs):
        results = run(args.bridge_url, args.corpus_file)
        all_results.append(results)
        s = score_clean_results(results)
        run_summaries.append(s)
        latency_summaries.append(_latency_summary_for(results))
        if args.runs > 1:
            print(
                f"[run {run_idx + 1}/{args.runs}] fp_rate={s['fp_rate'] * 100:.1f}%"
                f"  ({s['false_positives']}/{s['total']})"
            )

    n_errors = sum(
        1 for results in all_results for r in results if "error" in r
    )
    s = run_summaries[-1]  # last run's detail (models/categories/per-case) for the report
    pct = s["fp_rate"] * 100
    print(
        f"Clean-text FP eval — {s['false_positives']}/{s['total']} flagged ({pct:.1f}%)"
        + ("" if args.runs == 1 else f"  [run {args.runs}/{args.runs} shown below]")
    )
    for reg, v in sorted(s["by_register"].items()):
        print(f"  {reg:10s} {v['fp']}/{v['total']}")
    print(f"  by model:    {s['by_model']}")
    print(f"  by category: {s['by_category']}")
    for r in all_results[-1]:
        if r["flagged"]:
            edits = [
                f"{x.get('span')}→{x.get('replacement')!r} ({x.get('model')})"
                for x in r["suggestions"]
            ]
            print(f"  FP {r['id']} [{r['register']}]: {r['text']!r} -> {edits}")
    if n_errors:
        print(
            f"  {n_errors} request errors — a gate that could not measure must not pass"
        )
    print(format_latency_line(latency_summaries[-1]))

    gate_pct = pct
    if args.runs > 1:
        agg = aggregate_runs(run_summaries)
        mean_pct = agg["fp_rate"]["mean"] * 100
        stdev_pct = agg["fp_rate"]["stdev"] * 100
        min_pct = agg["fp_rate"]["min"] * 100
        max_pct = agg["fp_rate"]["max"] * 100
        print(
            f"\nAcross {args.runs} runs: fp_rate = {mean_pct:.2f}% +/- {stdev_pct:.2f}%"
            f"  (min={min_pct:.2f}% max={max_pct:.2f}%)"
        )
        gate_pct = mean_pct  # gate on the mean, not a lucky/unlucky single run

    out_path.write_text(
        json.dumps(
            {
                "bridge_url": args.bridge_url,
                "corpus_file": args.corpus_file,
                "n_runs": args.runs,
                "runs": [
                    {"summary": run_summaries[i], "latency": latency_summaries[i]}
                    for i in range(args.runs)
                ],
                "aggregate": aggregate_runs(run_summaries) if args.runs > 1 else None,
            },
            indent=2,
            ensure_ascii=False,
        )
    )

    if gate_pct > args.max_fp_rate:
        print(f"FAIL: fp_rate {gate_pct:.1f}% > max {args.max_fp_rate:.1f}%")
        return 1
    if n_errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
