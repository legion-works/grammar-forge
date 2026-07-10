#!/usr/bin/env python3
"""JFLEG held-out generalization eval (GLEU, multi-reference).

The 125-case golden set is hand-built and over-fit-prone: a high score there
proves failure CLASSES are closed, not real-world accuracy. JFLEG (Napoles et al.
2017) is an independent fluency-GEC benchmark — 754 dev sentences, 4 human
references each, scored with GLEU (its native metric: BLEU-like n-gram overlap
that rewards fluency rewrites and penalizes changes the references didn't make).

This is a DIRECTIONAL generalization signal, not a pass/fail gate. Report the
corpus GLEU and compare across pipeline variants; do not chase a perfect score
(human inter-annotator GLEU on JFLEG is ~0.62).

Data (gitignored, CC BY-NC-SA — local only): eval/jfleg_dev.jsonl, built from
github.com/keisks/jfleg dev/ (src + ref0..3). See README in this dir.

Persistence (task 7): every run writes eval/jfleg_results.json — GLEU (mean +/-
reference-choice std), a 95% bootstrap CI over sentence resampling, latency
percentiles, and (with --runs>1) cross-run mean/stdev/min/max — so a live run
finally leaves committed-friendly evidence, the way clean_baseline.json does
for the clean-text FP eval.

Usage:
    python3 eval/jfleg_eval.py [bridge_url] [n] [--runs N] [--out FILE]
      bridge_url  default http://127.0.0.1:8000
      n           optional: only score the first n sentences (quick check)
      --runs N    repeat the full pass N times; report mean +/- stdev, min/max
                  of corpus GLEU across runs (LLM sampling is stochastic)
      --out FILE  results file (default eval/jfleg_results.json)
"""

import json
import math
import random
import statistics
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

from lib_latency import format_latency_line, summarize_latencies

HERE = Path(__file__).parent
BRIDGE = "http://127.0.0.1:8000"
RESULTS_FILE = HERE / "jfleg_results.json"
ORDER = 4


def load_cases(path=None, limit=None):
    path = path or (HERE / "jfleg_dev.jsonl")
    cases = [
        json.loads(line)
        for line in Path(path).read_text().splitlines()
        if line.strip()
    ]
    if limit:
        cases = cases[:limit]
    return cases


def correct(text):
    body = json.dumps({"text": text, "source": "jfleg"}).encode()
    req = urllib.request.Request(
        BRIDGE + "/correct", data=body, headers={"Content-Type": "application/json"}
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


def ngrams(tokens, n):
    return Counter(tuple(tokens[i : i + n]) for i in range(len(tokens) + 1 - n))


def ngram_diff(a, b):
    """n-grams in a but not in b (Counter), per Napoles get_ngram_diff."""
    diff = Counter(a)
    for k in set(a) & set(b):
        del diff[k]
    return diff


def gleu_sentence_stats(hyp_toks, src_toks, ref_toks):
    """One (hyp, src, ref) -> (c, r, num1, den1, ... num4, den4), per the
    canonical Napoles gleu_stats. Numerator penalises hyp n-grams that match
    the SOURCE-but-not-the-ref (errors carried over / spurious changes)."""
    c = len(hyp_toks)
    r = len(ref_toks)
    stats = [c, r]
    for n in range(1, ORDER + 1):
        h_ng = ngrams(hyp_toks, n)
        s_ng = ngrams(src_toks, n)
        r_ng = ngrams(ref_toks, n)
        s_diff = ngram_diff(s_ng, r_ng)
        num = max(sum((h_ng & r_ng).values()) - sum((h_ng & s_diff).values()), 0)
        den = max(c + 1 - n, 0)
        stats.extend([num, den])
    return stats


def gleu_from_stats(stats, smooth=False):
    """Canonical GLEU from summed stats (c, r, num1, den1, ...)."""
    if smooth:
        stats = [s if s != 0 else 1 for s in stats]
    if any(x == 0 for x in stats):
        return 0.0
    c, r = stats[:2]
    log_prec = (
        sum(math.log(float(x) / y) for x, y in zip(stats[2::2], stats[3::2])) / ORDER
    )
    return math.exp(min(0, 1 - float(r) / c) + log_prec)


def collect_items(cases):
    """Fetch hypotheses from the bridge for every case; returns
    (items, unchanged_count, latencies_s, request_errors) where items is
    [(src_toks, hyp_toks, [ref_toks, ...]), ...]."""
    items = []
    unchanged = 0
    latencies = []
    request_errors = 0
    for c in cases:
        t0 = time.perf_counter()
        try:
            resp = correct(c["input"])
        except Exception as e:  # noqa: BLE001
            print(f"[{c['id']}] request error: {e!r}", file=sys.stderr)
            request_errors += 1
            latencies.append(time.perf_counter() - t0)
            continue
        latencies.append(time.perf_counter() - t0)
        hyp = apply_suggestions(c["input"], resp.get("suggestions") or [])
        if hyp == c["input"]:
            unchanged += 1
        items.append((c["input"].split(), hyp.split(), [r.split() for r in c["refs"]]))
    return items, unchanged, latencies, request_errors


def compute_gleu(items, iters=None):
    """Canonical multi-reference GLEU: per iteration, pick one ref per sentence
    at random (seed = iter*101), sum stats across the corpus, score once.
    Returns (mean, std_over_reference_choice, per_iter_scores)."""
    if not items:
        return 0.0, 0.0, []
    n_refs = len(items[0][2])
    iters = iters if iters is not None else (500 if n_refs > 1 else 1)
    per_iter = []
    for j in range(iters):
        random.seed(j * 101)
        total = [0] * (2 + 2 * ORDER)
        for src, hyp, refs in items:
            ri = random.randint(0, len(refs) - 1)
            st = gleu_sentence_stats(hyp, src, refs[ri])
            total = [a + b for a, b in zip(total, st)]
        per_iter.append(gleu_from_stats(total))
    mean = statistics.mean(per_iter)
    std = statistics.pstdev(per_iter) if len(per_iter) > 1 else 0.0
    return mean, std, per_iter


def bootstrap_ci(items, n_boot=300, alpha=0.05, seed=1234):
    """95%-default bootstrap CI over SENTENCE resampling (finite-sample
    uncertainty — complementary to compute_gleu's reference-choice variance).
    Each replicate resamples len(items) sentences WITH replacement and picks
    one reference per (resampled) sentence uniformly at random, matching the
    canonical multi-reference GLEU procedure. Returns (lo, hi, boot_scores)."""
    if not items:
        return 0.0, 0.0, []
    rng = random.Random(seed)
    n = len(items)
    boot_scores = []
    for _ in range(n_boot):
        total = [0] * (2 + 2 * ORDER)
        for _s in range(n):
            src, hyp, refs = items[rng.randrange(n)]
            ref = refs[rng.randrange(len(refs))]
            st = gleu_sentence_stats(hyp, src, ref)
            total = [a + b for a, b in zip(total, st)]
        boot_scores.append(gleu_from_stats(total))
    boot_scores.sort()
    lo_idx = int((alpha / 2) * n_boot)
    hi_idx = min(int((1 - alpha / 2) * n_boot), n_boot - 1)
    return boot_scores[lo_idx], boot_scores[hi_idx], boot_scores


def _parse_args(argv):
    argv = list(argv)
    runs = 1
    if "--runs" in argv:
        i = argv.index("--runs")
        runs = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2 :]
    out = None
    if "--out" in argv:
        i = argv.index("--out")
        out = argv[i + 1]
        argv = argv[:i] + argv[i + 2 :]
    bridge = argv[0] if len(argv) > 0 else "http://127.0.0.1:8000"
    limit = int(argv[1]) if len(argv) > 1 else None
    return bridge, limit, runs, out


def main():
    global BRIDGE
    bridge, limit, runs, out = _parse_args(sys.argv[1:])
    BRIDGE = bridge.rstrip("/")
    results_file = Path(out) if out else RESULTS_FILE
    cases = load_cases(limit=limit)

    run_reports = []
    for run_idx in range(runs):
        items, unchanged, latencies, request_errors = collect_items(cases)
        n = len(items)
        if n == 0:
            print("no sentences scored", file=sys.stderr)
            return 1
        mean, std, per_iter = compute_gleu(items)
        lo, hi, _boot = bootstrap_ci(items)
        lat_summary = summarize_latencies(latencies)
        run_reports.append(
            {
                "gleu_mean": mean,
                "gleu_std": std,
                "ci95_lo": lo,
                "ci95_hi": hi,
                "n_sentences": n,
                "unchanged": unchanged,
                "request_errors": request_errors,
                "latency": lat_summary,
            }
        )
        print("=" * 60)
        print(
            f"JFLEG dev  —  corpus GLEU = {mean:.4f}  (+/- {std:.4f})  "
            f"95% CI [{lo:.4f}, {hi:.4f}]  over {n} sentences"
            + ("" if runs == 1 else f"  [run {run_idx + 1}/{runs}]")
        )
        print(
            f"(left unchanged: {unchanged}/{n}; human IAA GLEU ~0.62 for reference)"
        )
        print(format_latency_line(lat_summary))
        print("=" * 60)

    agg = None
    if runs > 1:
        gleu_means = [r["gleu_mean"] for r in run_reports]
        agg = {
            "n_runs": runs,
            "gleu_mean": round(statistics.mean(gleu_means), 4),
            "gleu_stdev": round(statistics.stdev(gleu_means), 4)
            if len(gleu_means) > 1
            else 0.0,
            "gleu_min": round(min(gleu_means), 4),
            "gleu_max": round(max(gleu_means), 4),
        }
        print(
            f"Across {runs} runs: GLEU = {agg['gleu_mean']:.4f} "
            f"+/- {agg['gleu_stdev']:.4f}  (min={agg['gleu_min']:.4f} "
            f"max={agg['gleu_max']:.4f})"
        )

    results_file.write_text(
        json.dumps(
            {
                "benchmark": "jfleg-dev",
                "bridge_url": BRIDGE,
                "n_runs": runs,
                "runs": run_reports,
                "aggregate": agg,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
