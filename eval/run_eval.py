#!/usr/bin/env python3
"""GrammarForge GEC eval: feed a cases file to the bridge /correct endpoint,
apply the returned byte-offset suggestions, and score against gold.

Usage: python3 eval/run_eval.py [bridge_url] [cases_file] [--require-exact]
  bridge_url  default http://127.0.0.1:8000
  cases_file  default eval/golden.jsonl (JSONL of {id,cat,input,golden})
  --require-exact  exit 1 unless every case passed (default: exit 0)

results are written next to the cases file as <cases_stem>.results.json
(golden.jsonl -> golden.results.json; keeps multiple eval sets side by side).
"""

import argparse
import json
import sys
import urllib.request
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path

# Parse known flags before positional args so module-level code works.
_parser = argparse.ArgumentParser(add_help=True)
_parser.add_argument("--require-exact", action="store_true", default=False)
_known, _rest = _parser.parse_known_args()
REQUIRE_EXACT = _known.require_exact

BRIDGE = (_rest[0] if len(_rest) > 0 else "http://127.0.0.1:8000").rstrip("/")
HERE = Path(__file__).parent
CASES_FILE = Path(_rest[1]) if len(_rest) > 1 else (HERE / "golden.jsonl")
CASES = [
    json.loads(line) for line in CASES_FILE.read_text().splitlines() if line.strip()
]
# Default golden run writes results.json (errant_score.py reads that); a custom
# cases file writes <stem>.results.json so multiple sets coexist.
RESULTS_FILE = (
    (HERE / "results.json")
    if len(_rest) <= 1
    else CASES_FILE.with_suffix(".results.json")
)


def correct(text, source="eval"):
    body = json.dumps({"text": text, "source": source}).encode()
    req = urllib.request.Request(
        BRIDGE + "/correct", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def apply_suggestions(text, suggestions):
    """Apply byte-offset span replacements, last-to-first to keep offsets valid."""
    b = bytearray(text.encode("utf-8"))
    for s in sorted(suggestions, key=lambda x: x["span"]["start"], reverse=True):
        st, en = s["span"]["start"], s["span"]["end"]
        if st < 0 or en > len(b) or st > en:
            continue  # skip invalid span (itself a bug to flag)
        b[st:en] = s["replacement"].encode("utf-8")
    return b.decode("utf-8", errors="replace")


def sim(a, b):
    return SequenceMatcher(None, a, b).ratio()


def main():
    results = []
    by_cat = defaultdict(lambda: {"pass": 0, "total": 0})
    overall = {"pass": 0, "fail": 0}
    false_pos = []  # clean sentences the tool wrongly changed
    under = []  # tool did nothing but a fix was needed
    mis = []  # tool changed it but not to gold (over/mis-correction)
    invalid_span = []  # spans that don't apply cleanly (correctness bug)
    errors = []  # request errors / crashes

    for c in CASES:
        try:
            resp = correct(c["input"])
        except Exception as e:
            errors.append((c["id"], repr(e)))
            results.append({**c, "error": repr(e)})
            overall["fail"] += 1
            by_cat[c["cat"]]["total"] += 1
            continue

        sugs = resp.get("suggestions") or []
        # detect invalid spans before applying
        ilen = len(c["input"].encode("utf-8"))
        for s in sugs:
            sp = s["span"]
            if sp["start"] < 0 or sp["end"] > ilen or sp["start"] > sp["end"]:
                invalid_span.append((c["id"], sp, ilen))
        got = apply_suggestions(c["input"], sugs)
        models = sorted({s.get("model", "?") for s in sugs})

        ok = got == c["golden"]
        by_cat[c["cat"]]["total"] += 1
        if ok:
            by_cat[c["cat"]]["pass"] += 1
            overall["pass"] += 1
        else:
            overall["fail"] += 1
            if c["cat"] == "clean" and got != c["input"]:
                false_pos.append(c["id"])
            elif got == c["input"]:
                under.append(c["id"])
            else:
                mis.append(c["id"])

        results.append(
            {
                "id": c["id"],
                "cat": c["cat"],
                "input": c["input"],
                "golden": c["golden"],
                "got": got,
                "models": models,
                "score": resp.get("score"),
                "pass": ok,
                "similarity": round(sim(got, c["golden"]), 3),
                "n_suggestions": len(sugs),
            }
        )

    RESULTS_FILE.write_text(json.dumps(results, indent=2, ensure_ascii=False))

    # ---- report ----
    n = len(CASES)
    p = overall["pass"]
    print("=" * 70)
    print(f"GrammarForge GEC eval  —  {p}/{n} exact-match ({100 * p / n:.1f}%)")
    print("=" * 70)
    print("\nPer-category (exact match):")
    for cat in sorted(by_cat):
        d = by_cat[cat]
        bar = "#" * round(10 * d["pass"] / d["total"])
        print(
            f"  {cat:11s} {d['pass']:2d}/{d['total']:<2d}  {bar:<10s} {100 * d['pass'] / d['total']:.0f}%"
        )

    clean_total = by_cat["clean"]["total"]
    print(
        f"\nFalse positives (changed a correct sentence): {len(false_pos)}/{clean_total}"
        + (f"  ids={false_pos}" if false_pos else "")
    )
    print(f"Under-corrections (did nothing, fix needed):  {len(under)}  ids={under}")
    print(f"Mis/over-corrections (wrong change):          {len(mis)}  ids={mis}")
    print(
        f"INVALID SPANS (apply bug):                    {len(invalid_span)}"
        + (f"  {invalid_span}" if invalid_span else "")
    )
    print(
        f"Request errors/crashes:                       {len(errors)}"
        + (f"  {errors}" if errors else "")
    )

    fails = [r for r in results if not r.get("pass")]
    if fails:
        print(f"\n--- {len(fails)} FAILURES (input | gold | got | models | sim) ---")
        for r in fails:
            if "error" in r:
                print(f"[{r['id']:>2}|{r['cat']}] ERROR {r['error']}")
                continue
            print(
                f"[{r['id']:>2}|{r['cat']}] sim={r['similarity']} models={r['models']}"
            )
            print(f"    in   : {r['input']}")
            print(f"    gold : {r['golden']}")
            print(f"    got  : {r['got']}")

    # average similarity (partial-credit signal)
    sims = [r["similarity"] for r in results if "similarity" in r]
    if sims:
        print(f"\nMean char similarity to gold: {sum(sims) / len(sims):.3f}")
    else:
        print("\nMean char similarity to gold: N/A (no results with similarity)")

    if REQUIRE_EXACT and overall["fail"] > 0:
        print(f"\n--require-exact: {overall['fail']} failures → exit 1")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
