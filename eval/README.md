# GrammarForge eval

Two complementary GEC evaluations for the bridge `/correct` pipeline.

## 1. Golden set (`golden.jsonl`) — primary regression gate

125 hand-built, reviewed cases (`{id, cat, input, golden}`), one minimal correction
each, across 16 categories (sva, tense, article, plural, homophone, spelling, caps,
punct, prep, pronoun, negation, confusable, wordorder, multi, unicode, **clean**). The
20 `clean` cases are over-correction bait (code snippets, accented text, uncountable
"less water", `data suggest`) — the tool must leave them **unchanged**.

> Hand-built sets are over-fit-prone: a high score proves failure *classes* are closed
> and clean text doesn't regress, NOT real-world accuracy. Pair it with JFLEG (below).

```bash
# 1. bring up the stack (or a local bridge) on a URL, then:
python3 eval/run_eval.py http://127.0.0.1:8000          # -> eval/results.json + report
eval/.venv/bin/python eval/errant_score.py              # ERRANT span-level P/R/F0.5

# custom cases file (writes <stem>.results.json next to it):
python3 eval/run_eval.py http://127.0.0.1:8000 path/to/cases.jsonl
```

`run_eval.py` reports exact-match per category + false-positive / under- / over-correction
/ invalid-span breakdowns. `errant_score.py` is the canonical span-level metric (F0.5,
precision-weighted) over `results.json`.

## 2. JFLEG held-out (`jfleg_eval.py`) — generalization signal

[JFLEG](https://github.com/keisks/jfleg) (Napoles et al. 2017) is an independent fluency
GEC benchmark: 754 dev sentences, 4 human references each, scored with **GLEU** (its native
multi-reference metric). The model never saw these, so it checks whether golden-set gains
generalize. This is a **directional signal, not a pass/fail gate** (human inter-annotator
GLEU on JFLEG is ~0.62).

The data is **gitignored** (CC BY-NC-SA corpus text — not committed to this public repo).
Regenerate it locally:

```bash
# fetch the dev split (src + 4 refs) and build eval/jfleg_dev.jsonl
mkdir -p /tmp/jfleg
for f in dev.src dev.ref0 dev.ref1 dev.ref2 dev.ref3; do
  curl -fL -o /tmp/jfleg/$f "https://raw.githubusercontent.com/keisks/jfleg/master/dev/$f"
done
python3 - <<'PY'
import json
from pathlib import Path
d = Path("/tmp/jfleg")
src = d.joinpath("dev.src").read_text().splitlines()
refs = [d.joinpath(f"dev.ref{i}").read_text().splitlines() for i in range(4)]
with open("eval/jfleg_dev.jsonl", "w") as f:
    for i, s in enumerate(src):
        f.write(json.dumps({"id": i, "input": s.strip(),
                            "refs": [r[i].strip() for r in refs]}) + "\n")
print("wrote eval/jfleg_dev.jsonl", len(src), "sentences")
PY

# then score (the GLEU impl is a faithful Py3 port of Napoles' canonical gleu.py):
eval/.venv/bin/python eval/jfleg_eval.py http://127.0.0.1:8000        # full 754
eval/.venv/bin/python eval/jfleg_eval.py http://127.0.0.1:8000 100    # quick: first 100
```

## 3. Standard academic benchmarks — comparable F0.5 (`conll14_eval.py`, `bea19_eval.py`)

The golden set and JFLEG are NOT comparable to published GEC numbers. These two are: they
run the bridge over the standard benchmarks and score with the **canonical scorers**, so the
F0.5 sits directly beside published SOTA.

```bash
bash eval/get_benchmarks.sh                                   # one-time: download data + m2scorer (gitignored)
eval/.venv/bin/python eval/conll14_eval.py http://127.0.0.1:8000        # CoNLL-2014-test (m2scorer)
eval/.venv/bin/python eval/bea19_eval.py  http://127.0.0.1:8000        # BEA-2019-dev (ERRANT)
eval/.venv/bin/python eval/conll14_eval.py http://127.0.0.1:8000 50    # quick: first 50 sentences
```

Run them with **`eval/.venv/bin/python`** (they need `nltk` + `errant`). The corpora live under
`eval/benchmarks/` and are **gitignored** (NUS NUCLE / Cambridge W&I+LOCNESS are
non-redistributable) — regenerate with `get_benchmarks.sh`.

**Tokenization is the #1 foot-gun, and it is OPPOSITE per benchmark:**
- **CoNLL-2014** gold is PTB/NLTK-tokenized (`risk ?`, `disease .`). The bridge's `/correct`
  output de-tokenizes punctuation, so `conll14_eval.py` re-tokenizes the hypothesis with
  `nltk.word_tokenize` before m2scorer. **This is the headline, exact-comparable number.**
- **BEA-2019-dev** is scored by ERRANT (`errant_parallel` → `errant_compare`) on detokenized
  natural source. **BEA-dev here is APPROXIMATE / directional only:** the official gold m2 was
  built with `errant==2.0.0` (Python ≤3.6, uninstallable in our 3.13 venv); we run `errant
  3.0.2`, whose tokenization differs slightly and inflates FP. The slow-path LLM also
  over-corrects learner text vs the minimal-edit gold. Treat CoNLL-2014 as the headline.

**Definitive result (FULL sets, 2026-06-09):** CoNLL-2014-test **F0.5 = 60.86** (P 65.00 /
R 48.50, 1312 sents, ~4 min) — a strong single-model GEC result, ~4–5 F0.5 below published
GECToR single-model (65.3) and below the ensemble SOTA (76). The shape is **precision-leaning**
(the cascade is conservative — it doesn't over-correct, good for a writing assistant, but
recall 48% means it misses over half the aggressive gold edits; the top quality lever is a
2nd GEC model for majority-vote before LLM escalation). BEA-2019-dev **F0.5 = 14.53**
(4384 sents, ~12 min) is **directional only** — see the errant-2.0.0-vs-3.0.2 + over-correction
caveat above; do not read it as our true BEA standing. (A 25-sentence subset gave a rosier
66.9 — small-sample optimism; the full set is the honest number.) The prior 59.78 was inflated
by PTB-tokenized-source punctuation false positives (the LLM strips the space around `"risk ?"`),
now removed by submitting de-tokenized source to the bridge — a real-client-faithful measurement.

## ERRANT / benchmark venv setup (`.venv`, gitignored)

```bash
cd eval && uv venv && uv pip install errant "click<8.2" nltk pytest ruff && \
  .venv/bin/python -m spacy download en_core_web_sm && \
  .venv/bin/python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab')"
```

The `click<8.2` pin is required (typer dropped the click shim spaCy's `download` CLI uses).
`nltk` (+ `punkt`/`punkt_tab`) is needed for CoNLL PTB tokenization; `pytest`/`ruff` run the
harness unit tests + lint. `jfleg_eval.py` needs no extra deps (pure stdlib).
