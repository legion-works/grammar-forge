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

Usage:
    python3 eval/jfleg_eval.py [bridge_url] [n]
      bridge_url  default http://127.0.0.1:8000
      n           optional: only score the first n sentences (quick check)
"""
import json
import sys
import urllib.request
from collections import Counter
from pathlib import Path

BRIDGE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000").rstrip("/")
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else None
HERE = Path(__file__).parent
CASES = [json.loads(l) for l in (HERE / "jfleg_dev.jsonl").read_text().splitlines() if l.strip()]
if LIMIT:
    CASES = CASES[:LIMIT]


def correct(text):
    body = json.dumps({"text": text, "source": "jfleg"}).encode()
    req = urllib.request.Request(BRIDGE + "/correct", data=body,
                                 headers={"Content-Type": "application/json"})
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


ORDER = 4


def ngrams(tokens, n):
    return Counter(tuple(tokens[i:i + n]) for i in range(len(tokens) + 1 - n))


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
    import math
    if smooth:
        stats = [s if s != 0 else 1 for s in stats]
    if any(x == 0 for x in stats):
        return 0.0
    c, r = stats[:2]
    log_prec = sum(math.log(float(x) / y) for x, y in zip(stats[2::2], stats[3::2])) / ORDER
    return math.exp(min(0, 1 - float(r) / c) + log_prec)


def main():
    import random
    import statistics

    # 1. Collect hypotheses from the bridge.
    items = []  # (src_toks, hyp_toks, [ref_toks...])
    unchanged = 0
    for c in CASES:
        try:
            resp = correct(c["input"])
        except Exception as e:  # noqa: BLE001
            print(f"[{c['id']}] request error: {e!r}", file=sys.stderr)
            continue
        hyp = apply_suggestions(c["input"], resp.get("suggestions") or [])
        if hyp == c["input"]:
            unchanged += 1
        items.append((c["input"].split(), hyp.split(), [r.split() for r in c["refs"]]))

    n = len(items)
    if n == 0:
        print("no sentences scored", file=sys.stderr)
        return 1

    # 2. Canonical multi-reference GLEU: per iteration, pick one ref per sentence
    #    at random (seed = iter*101), sum stats across the corpus, score once.
    iters = 500 if len(CASES[0]["refs"]) > 1 else 1
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

    print("=" * 60)
    print(f"JFLEG dev  —  corpus GLEU = {mean:.4f}  (+/- {std:.4f})  over {n} sentences")
    print(f"(left unchanged: {unchanged}/{n}; {iters} iters; "
          f"human IAA GLEU ~0.62 for reference)")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
