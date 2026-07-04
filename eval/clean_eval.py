#!/usr/bin/env python3
"""Clean-text false-positive eval: every sentence in the corpus is known-clean;
ANY suggestion returned by /correct is a false positive (deliberately stricter
than run_eval.py's applied-text-differs check — a suggestion on clean text is a
user-visible underline even when applying it would be a no-op).

Usage: python3 clean_eval.py [bridge_url] [corpus_file] [--max-fp-rate PCT]
Exit 0 when fp_rate <= --max-fp-rate (default 100 = report-only), else 1.
"""

import argparse
import json
import sys
import urllib.request


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
                    }
                )
            except Exception as e:
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
                    }
                )
    return results


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
    args = p.parse_args()

    results = run(args.bridge_url, args.corpus_file)
    n_errors = sum(1 for r in results if "error" in r)
    s = score_clean_results(results)
    pct = s["fp_rate"] * 100
    print(
        f"Clean-text FP eval — {s['false_positives']}/{s['total']} flagged ({pct:.1f}%)"
    )
    for reg, v in sorted(s["by_register"].items()):
        print(f"  {reg:10s} {v['fp']}/{v['total']}")
    print(f"  by model:    {s['by_model']}")
    print(f"  by category: {s['by_category']}")
    for r in results:
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
    if pct > args.max_fp_rate:
        print(f"FAIL: fp_rate {pct:.1f}% > max {args.max_fp_rate:.1f}%")
        return 1
    if n_errors:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
