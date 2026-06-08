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

## ERRANT venv setup (`.venv`, gitignored)

```bash
cd eval && uv venv && uv pip install errant "click<8.2" && \
  .venv/bin/python -m spacy download en_core_web_sm
```

The `click<8.2` pin is required (typer dropped the click shim spaCy's `download` CLI uses).
`jfleg_eval.py` needs no extra deps (pure stdlib).
