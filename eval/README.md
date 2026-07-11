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

### Determinism: the COLD-RESTART protocol (required for comparable runs)

Golden-set results depend on the llama.cpp **prompt-cache state**: a warm server reuses
KV-cache prefixes from earlier requests, which can shift sampling and flip borderline
cases. Runs are only comparable to the committed baseline (and to each other) when taken
cold. The protocol:

1. **Neutralize prompt personalization.** The bridge injects accepted/rejected few-shot
   examples from the signal log into the system prompt (SPEC §5.5), so accumulated
   signals change eval output. Either run against a fresh `corrections.db`, set
   `GF_PERSONALIZATION_ENABLED=false` on the bridge, or clear stale signals
   (`UPDATE edits SET signal=NULL, signal_ts=NULL`) — then **restart the bridge** so its
   TTL-cached personalization snapshot is dropped.
1. **Empty the user dictionary.** Dictionary words are injected into the system prompt
   as protected vocabulary, so a populated dictionary shifts prompts (and sentence-cache
   keys) away from the baseline. Back up and truncate the file at
   `GF_HARPER_USER_DICT` (default `/data/user-dict.txt`); restore it after the run.
   An EMPTY dictionary produces prompts byte-identical to the no-dictionary build.
2. **Cold-restart the LLM backend** and wait for warmup (~25 s for the default
   llama.cpp container):
   ```bash
   docker compose restart llamacpp && sleep 25
   ```
3. **Run the full set** — never gate on a subset:
   ```bash
   python3 eval/run_eval.py http://127.0.0.1:8000
   ```

> **Never gate a prompt change on a probe subset.** A measured system-prompt candidate
> passed a 20-case probe but DROPPED the full cold eval 119→117 (new under-corrections
> from over-conservatism). Only the full 125-case cold run decides.

**Committed baseline (`results.json`): 125/125** (ERRANT span-level F0.5 1.000)
with the default `gemma-4-E4B-it-qat-Q4_K_XL` chat path. The two former
deterministic model-side failures are now closed by the **LLM over-edit repair
chain** (`internal/correction/overedit.go`, `GF_OVEREDIT_FILTER`, default on),
which deterministically reverts the offending output classes BEFORE the diff:
- `91` (caps) — the model rewrote "Paris in France" → "Paris, France," (an
  idiom-level over-edit beyond the minimal capitalization fix); the
  proper-noun comma-restore rule reverts the restructure, keeping the caps.
- `118` (clean) — the model "fixed" correct proximity agreement
  ("Neither the manager nor the employees were" → "was"); the
  proximity-agreement rule reverts the flip.

Any failing case in a cold run now indicates a pipeline change (or a non-cold
run) — investigate before trusting the number. History: 119/125 (failures
`40, 79, 96, 112, 113, 118`) → 123/125 when the user-dictionary feature
switched Harper to its merged-dictionary path by default
(`GF_HARPER_USER_DICT`), changing fast-path lints and therefore LLM escalation
routing (+4, one new over-edit `91`) → 125/125 with the over-edit repair
chain. The raw model behaviour on 91/118 is unchanged — disabling
`GF_OVEREDIT_FILTER` restores the 123/125 result.

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
eval/.venv/bin/python eval/jfleg_eval.py http://127.0.0.1:8000 --runs 3  # mean+/-stdev across 3 full passes
```

**Every run now persists evidence to `eval/jfleg_results.json`** (this was previously
the one benchmark that never left a committed-friendly artifact — a live run's number
only ever existed in a terminal scrollback). Each run's entry carries corpus GLEU (mean
+/- reference-choice std, from the canonical multi-reference procedure), a 95%
**bootstrap CI** (sentence-resampling — the complementary "how much would this vary with
a different sample of 754 sentences" uncertainty), and latency percentiles (p50/p95/p99).
`--runs N` repeats the full pass N times and additionally reports cross-run
mean/stdev/min/max GLEU (LLM sampling is stochastic; a single pass has no error bars).

## 3. Standard academic benchmarks — comparable F0.5 (`conll14_eval.py`, `bea19_eval.py`)

The golden set and JFLEG are NOT comparable to published GEC numbers. These two are: they
run the bridge over the standard benchmarks and score with the **canonical scorers**, so the
F0.5 sits directly beside published SOTA.

> **STALE-NUMBERS WARNING (as of 2026-07-10):** the committed CoNLL-2014 (F0.5 60.86, P
> 65.0/R 48.5, dated 2026-06-09) and BEA-2019-dev (F0.5 14.53) numbers **predate the
> over-edit filter** (`internal/correction/overedit.go`, `GF_OVEREDIT_FILTER`) that the
> golden set's 125/125 now depends on (see §1's history: 123/125 → 125/125 when the filter
> landed). Neither academic benchmark has been re-run cold since. Both numbers are
> DIRECTIONALLY informative (precision-leaning shape, the ballpark recall gap) but are
> **not current** — do not cite them as today's standing without a fresh cold run via
> `eval/run_all.sh` (§8 below). BEA-2019-dev additionally carries the instrument caveat
> below, now fixed as of this revision.

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
  natural source.

### The BEA-19 instrument fix (2026-07-10)

The prior BEA-dev F0.5 (14.53) scored an errant-3.0.2-annotated hypothesis against the
OFFICIAL gold m2, which was built upstream with `errant==2.0.0` (Python ≤3.6, uninstallable
in this 3.13 venv). Comparing edits from two different errant versions isn't a like-for-like
diff — 2.0.0 and 3.0.2 tokenize/classify some spans differently, so semantically-identical
edits land in different `(start, end, c_str)` buckets and score as spurious FP/FN. That's
why 14.53 was flagged an **uncalibrated instrument**, not a real BEA standing.

Three options were evaluated:
- **(a) Re-annotate both sides with the installed errant.** The gold m2's own edit lines
  still carry the raw corrections, so the gold CORRECTED TEXT is recoverable by applying
  them to the tokenized source (`lib_m2.read_m2_annotated`). Re-running `errant_parallel` on
  `(source, reconstructed-gold-correction)` — the SAME binary/version used for the
  hypothesis — produces a reference m2 through an IDENTICAL annotation pipeline.
- **(b) Pin `errant==2.0.0` in a dedicated venv.** Rejected: needs Python ≤3.6, can't coexist
  with the nltk/spaCy 3.13 venv CoNLL-14 already depends on, and would cost the owner a
  second interpreter just for one script — not turnkey.
- **(c) Both behind a flag.** **Implemented.** Regeneration (a) is the default (it's the
  actual fix); `--legacy-gold` reproduces the OLD cross-version behavior for continuity with
  the historical 14.53 datapoint, clearly labeled non-comparable in its own output.

```bash
eval/.venv/bin/python eval/bea19_eval.py http://127.0.0.1:8000                 # regenerated-reference (default, FIXED)
eval/.venv/bin/python eval/bea19_eval.py http://127.0.0.1:8000 --legacy-gold   # old cross-version behavior (historical only)
```

Net effect: the default-mode number is now an apples-to-apples ERRANT diff (same annotator
version both sides) — a TRUSTWORTHY directional/diagnostic number instead of a discredited
one. It is still not bit-comparable to the published BEA leaderboard (which used errant
2.0.0 end to end) — CoNLL-2014 (m2scorer) remains the headline, exact-comparable number.

### ERRANT per-error-type breakdown (both benchmarks)

Both `conll14_eval.py` and `bea19_eval.py` now print AND persist a per-error-type P/R/F0.5
table (ERRANT's own operation+type codes — `M:DET`, `R:VERB:TENSE`, `U:PREP`, ...), sorted
by gold-edit count. Neither m2scorer nor `errant_compare` breaks this out on their own — this
is THE diagnostic for "which error types carry CoNLL's 48.5% recall gap" (§ warning above).
Mirrors `errant_score.py`'s existing per-category (golden-set `cat` tag) structure, bucketing
by ERRANT type instead; see `lib_errant_types.py`. For CoNLL-14, the gold CORRECTED TEXT is
reconstructed from the M2's own edit lines the same way as the BEA fix, then re-annotated
with errant — a secondary diagnostic diff, independent of (and not replacing) the m2scorer
headline number.

### Latency + persisted results

Every bridge call in both scripts is timed (`time.perf_counter`); p50/p95/p99/mean are
printed and persisted. Both scripts now write a results file (previously they only printed to
stdout): `eval/benchmarks/conll14/conll14_results.json` and
`eval/benchmarks/bea19/bea19_results.json`, each carrying `{p, r, f05, latency,
by_error_type, ...}`.

**Last known-good FULL-set numbers (2026-06-09, STALE per the warning above):**
CoNLL-2014-test F0.5 = 60.86 (P 65.00 / R 48.50, 1312 sents, ~4 min) — a strong single-model
GEC result, ~4–5 F0.5 below published GECToR single-model (65.3) and below the ensemble SOTA
(76). The shape is **precision-leaning** (the cascade is conservative — it doesn't
over-correct, good for a writing assistant, but recall 48% means it misses over half the
aggressive gold edits; the top quality lever is a 2nd GEC model for majority-vote before LLM
escalation — the new per-type breakdown above is where to look first). BEA-2019-dev F0.5 =
14.53 (4384 sents, ~12 min) was measured under the OLD cross-version instrument (see fix
above) — re-run with the fixed default mode before trusting a BEA number again.

## ERRANT / benchmark venv setup (`.venv`, gitignored)

```bash
cd eval && uv venv && uv pip install errant "click<8.2" nltk pytest ruff && \
  .venv/bin/python -m spacy download en_core_web_sm && \
  .venv/bin/python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab')"
```

The `click<8.2` pin is required (typer dropped the click shim spaCy's `download` CLI uses).
`nltk` (+ `punkt`/`punkt_tab`) is needed for CoNLL PTB tokenization; `pytest`/`ruff` run the
harness unit tests + lint. `jfleg_eval.py` needs no extra deps (pure stdlib).

## 4. Clean-text FP eval

Every sentence in `clean_corpus.jsonl` is known-clean; any suggestion is a false
positive (deliberately STRICTER than run_eval.py's applied-text-differs check —
a suggestion on clean text is a user-visible underline even when applying it is
a no-op; do not "align" the two definitions). Regenerate the corpus with
`build_clean_corpus.py` after golden changes.

    python3 clean_eval.py http://127.0.0.1:8001 clean_corpus.jsonl --max-fp-rate 12

Baseline lives in `clean_baseline.json` — gate PRs at (baseline + 2pp) or better.
Registers: `golden` (golden outputs), `casual`, `technical`, `british`.
Per-model attribution tells you WHERE the FP came from (`harper`/`gector`/`llm`).
The baseline was measured with GF_HARPER_DIALECT=british (live config). Golden gates run with american — see the dialect note in the plan; never compare FP numbers across dialect envs (single-dialect runs, that is — see `dialect_matrix.py` in §8, which runs BOTH dialects in one report instead).

**Variance across runs (`--runs N`):** LLM sampling is stochastic, so a single run's
fp_rate has no error bars. `--runs N` repeats the full corpus N times and reports mean
+/- stdev and min/max (gating on the MEAN, not a lucky/unlucky single run); every
individual run is persisted (not just the aggregate) to `--out` (default
`<corpus_stem>.runs.json`) so an outlier run is inspectable, not just averaged away.

    python3 clean_eval.py http://127.0.0.1:8001 clean_corpus.jsonl --runs 5 --max-fp-rate 12

## 5. Semantic verifier calibration (Phase C, Task C4)

The post-LLM semantic verifier (`internal/semverify`, MiniLM
`sentence-transformers/all-MiniLM-L6-v2`) was a candidate Phase C gate — a
universal cosine threshold on the LLM rewrite vs. the original that would
discard catastrophic rewrites before diffing. A threshold study was run
before any operator enable.

**Verdict (commit `9a379ca` calibration): NO SAFE THRESHOLD.**

- 125 golden `(input, golden)` pairs + 34 LLM over-edit fixtures (extracted
  from `bridge/internal/correction/overedit_test.go`) were embedded with
  MiniLM and cosine-scored.
- Distribution summary (numbers from the Go reference; Python reference
  agrees to ≤1e-6 per pair, see `verifier_equivalence_diff.json`):

  |             | min  | p5  | p95  | max  |
  | ----------- | ---- | --- | ---- | ---- |
  | golden      | 0.5664 | 0.8083 | 1.0000 | 1.0000 |
  | over-edit   | 0.6264 | 0.6264 | 1.0000 | 1.0000 |

  **Separation (min_golden − max_overedit) = −0.4336** — inverted. Many
  over-edits (contraction expansions, casing single-letter flips, comma
  restores) are **semantically identical** to the original at the embedding
  level, so a universal threshold can never reject them without also
  discarding legitimate corrections that happen to score low (e.g. golden
  case 55's heavily-rewritten input scores 0.5664, below many over-edits).

- The verifier interface, wiring, and probe remain in the tree (gated to
  `cgo && ORT`, off by default); the operator action to enable any
  threshold remains blocked until either (a) a per-rule threshold (only
  fires on the rewrite-classes that *do* drop cosine — singular-they,
  modal-have) replaces the universal gate, or (b) a paired-feature classifier
  is added (out of scope).

### Reproducing the study

```bash
# Python reference (sentence-transformers). Caches under eval/.huggingface_cache/,
# so the project tree stays tidy and the system ~/.cache permission is bypassed.
cd eval
HF_HOME="$PWD/.huggingface_cache" HF_HUB_CACHE="$PWD/.huggingface_cache/hub" \
    .venv/bin/python3 verifier_calibration.py golden.jsonl overedit_fixtures.jsonl

# Go probe (hugot) — runs the same pair set via the real bridge build.
docker build -t grammarforge-bridge:dev bridge/
docker run --rm \
  -v "$PWD/eval:/eval" -v "$PWD/bridge/models/minilm:/models/minilm" \
  --entrypoint /bin/sh grammarforge-bridge:dev \
  -c '/usr/local/bin/semverify-probe /models/minilm /eval/overedit_fixtures.jsonl \
      /eval/golden.jsonl > /eval/semverify_probe_scores.tsv'

# Cross-check the two and re-emit the ground-truth verdict (Go numbers).
.venv/bin/python3 verifier_equivalence_check.py
```

Output artifacts (committed):
- `verifier_calibration_scores.json` — Python per-pair cosines + summary
- `semverify_probe_scores.tsv` — Go per-pair cosines (`id<TAB>cosine`)
- `verifier_equivalence_diff.json` — merged per-pair |python−go| + verdict + Go-only threshold re-study
- `overedit_fixtures.jsonl` — the 34 fixture pairs extracted from `overedit_test.go`

## 6. Trusted-category escalation routing (Phase B, Task B2)

`GF_ESCALATION_TRUSTED_CATEGORIES` (default `""` = legacy
`GF_SKIP_LLM_FOR_SPELLING_ONLY` semantics) extends the spelling-only skip
into a configurable category set — only fast-path results where EVERY
suggestion's category is in the trust set skip the LLM. Grammar
(`CategoryGrammar`, the empty string) is never trustable; the bridge
parser (`config.ParseTrustedCategories`) rejects empty tokens, the literal
`grammar`, and unknown category names by ignoring the WHOLE variable (a typo
must not silently produce a partial-subset foot-gun).

**Default deploys keep `""`.** Enablement is an eval-gated operator action —
no candidate set goes live on a real deploy without passing BOTH gates below
on `gf-bridge-eval`:

1. **Data-driven motivation.** Pick a candidate set from
   `clean_baseline.json[by_category]` — categories with no eval-visible LLM
   lift (the LLM's contribution there is zero) are the candidates for
   trusted-set inclusion. Spelling-only skip has a **mixed empirical
   history**: the legacy `SkipLLMForSpellingOnly` exists, but a full cold
   golden eval (2026-06-10) measured blanket escalation as justified
   (123/125 → 116/125 with the skip on — Harper's dictionary engine emits
   confident-wrong morphology suggestions like `buyed`→`bayed`). Even
   `spelling` therefore needs **fresh Phase-A per-category attribution
   data** before any re-enablement — pick candidates from data, not
   intuition.

2. **Both gates must pass, in this order:**
   ```bash
   docker build -t grammarforge-bridge:dev bridge/
   docker run -d --name gf-bridge-eval --network homelab_default \
       -p 127.0.0.1:8001:8000 \
       -e GF_ESCALATION_TRUSTED_CATEGORIES='spelling,typography' \
       -e GF_HARPER_DIALECT=american \
       -v "$PWD/bridge/models/gector:/models/gector" \
       grammarforge-bridge:dev

   # exit 0 ⇒ 125/125 exact
   eval/.venv/bin/python3 run_eval.py --require-exact http://127.0.0.1:8001

   # ≤ baseline ⇒ no clean-text regression on the trusted-set-induced skips
   eval/.venv/bin/python3 clean_eval.py http://127.0.0.1:8001 \
       clean_corpus.jsonl --max-fp-rate $(jq -r '.fp_rate * 100 + 2' clean_baseline.json)

   docker stop gf-bridge-eval
   ```

   A single low score is **not** a regression: double-run back-to-back plus a
   `/correct` homophone sanity check (expect `model:"llm"`) before concluding
   the trust set broke something. Any candidate set that fails EITHER gate
   stays off; the default `""` stays the deploy default. **Never** set this
   flag on the live container without first running both gates on
   `gf-bridge-eval`; the operator-action gate exists so a routing change
   never ships without evidence.

## 7. Operator enable protocol — calibrated escalation

`GF_ESCALATION_CALIBRATED` (default `false`) wires the SAME
`correction.ConfidenceCalibrator` used for `GF_CONFIDENCE_CALIBRATION`
(display) onto `correction.Service.SetEscalationCalibrator` (routing):
setting either flag alone is enough for main to CONSTRUCT the calibrator
(`cfg.ConfidenceCalibration || cfg.EscalationCalibrated`), and each flag
independently controls which setter is called. With `GF_ESCALATION_CALIBRATED`
on, a fast-path suggestion set that fails the `EscalateOnFastEdit` /
`TrustedCategories` check gets one more chance to skip the LLM: if EVERY
suggestion is non-grammar AND the calibrator reports a value at or above
`MinConfidence` for that suggestion's `(model, category)` bucket, the LLM
call is elided (see `correction.EscalationPolicy.ShouldEscalate`'s
`calibrated` parameter). `CategoryGrammar` (`""`) never skips — same
invariant as the Phase-B trusted-set exception in §6.

**Default deploys keep `GF_ESCALATION_CALIBRATED=false`.** Enabling it is an
eval-gated operator action; do not flip it on a live container without first
clearing the prerequisite and passing both gates below on `gf-bridge-eval`.

### (a) Prerequisite: every routing-relevant bucket must be warm

The calibrator reports `ok=false` (raw confidence kept, no skip) for any
`(model, category)` bucket with fewer than `GF_CALIBRATION_MIN_SAMPLES`
(default 10) accepted+rejected signals — so an under-sampled bucket is safe
by construction, but it also means the flag is a no-op for that bucket until
enough `/signal` feedback has accumulated. Before enabling, confirm every
bucket the fast path actually emits on the routing-relevant categories
(`harper`/spelling, `harper`/punctuation, `harper`/typography,
`gector`/grammar) has reached the threshold:

```bash
curl -s http://127.0.0.1:8001/stats | jq '.signal_rates[] | select(.accepted + .rejected < 10)'
```

An empty result means every observed bucket is warm enough to be trusted.
Buckets absent from `signal_rates` entirely have zero signals and are
equally under threshold — the flag will not skip the LLM for them until
signal volume accumulates naturally (or via a deliberate signal-generation
pass), so there is nothing to force here; just re-check before enabling.

### (b) The two-env eval gate

Same recipe as §6, `-e GF_ESCALATION_CALIBRATED=true` added, and BOTH
sub-gates must pass:

```bash
docker build -t grammarforge-bridge:dev bridge/

# Golden gate: american dialect, exact-match required.
docker run -d --name gf-bridge-eval --network homelab_default \
    -p 127.0.0.1:8001:8000 \
    -e GF_ESCALATION_CALIBRATED=true \
    -e GF_HARPER_DIALECT=american \
    -v "$PWD/bridge/models/gector:/models/gector" \
    grammarforge-bridge:dev

# exit 0 ⇒ 125/125 exact
eval/.venv/bin/python3 run_eval.py --require-exact http://127.0.0.1:8001

docker stop gf-bridge-eval && docker rm gf-bridge-eval

# Clean-FP gate: british dialect + the dialect spelling guard, since a
# calibrated skip is most likely to fire on the spelling/punctuation
# categories the guard also touches.
docker run -d --name gf-bridge-eval --network homelab_default \
    -p 127.0.0.1:8001:8000 \
    -e GF_ESCALATION_CALIBRATED=true \
    -e GF_HARPER_DIALECT=british \
    -e GF_DIALECT_SPELLING_GUARD=true \
    -v "$PWD/bridge/models/gector:/models/gector" \
    grammarforge-bridge:dev

# ≤ baseline + 2pp ⇒ no clean-text regression from the calibrated skip
eval/.venv/bin/python3 clean_eval.py http://127.0.0.1:8001 \
    clean_corpus.jsonl --max-fp-rate $(jq -r '.fp_rate * 100 + 2' clean_baseline.json)

docker stop gf-bridge-eval && docker rm gf-bridge-eval
```

Both the golden gate (american) and the clean-FP gate (british +
`GF_DIALECT_SPELLING_GUARD=true`) must pass before the flag goes live on any
real deploy. A single low score is not itself a regression — re-run
back-to-back before concluding the flag broke something (mirrors §6).

### (c) Rollback

`GF_ESCALATION_CALIBRATED` is a pure routing gate with no schema or data
migration attached — rollback is always a config change, never a code
revert:

1. Unset (or set `false`) `GF_ESCALATION_CALIBRATED` in the deploy
   environment.
2. Recreate the container (`docker stop` + `docker rm` + `docker run` with
   the updated env — an env change does not apply to a running container).
3. Re-run the golden gate flag-off and confirm `125/125` — this reconfirms
   the deploy is back to the flag's default (legacy, byte-identical)
   behaviour, not just that the flag is unset in the env file.

Because the default (`false`) is always the legacy, already-shipped
behaviour, a rollback never requires reverting any code change — only the
env var and a container recreate.

## 8. Gated turnkey runs (`GF_GATE=1`)

`run_all.sh` is report-only by default (exit 0 regardless of step outcomes).
Two additions make it machine-enforceable:

- The golden step runs with `--require-exact`; the clean step runs with
  `--max-fp-rate` derived from `clean_baseline.json` (`fp_rate`×100 rounded
  to one decimal + 2pp — currently 11.6% + 2pp = 13.6, PERCENT units).
- Every step's stdout+stderr is tee'd to `eval/logs/run_all/<step>.out`
  (gitignored). `lib_summary.py` parses THOSE files — never the live
  terminal — into `eval/run_all_summary.json`, which now carries per-step
  headline metric values (golden `passed/total`, conll14/bea19 `p/r/f05`,
  jfleg `gleu`, clean `fp_count/total/rate`, calibration `ece`) plus a
  `"gate"` field with FOUR states:
  - `"pass"` — ran, exit 0, metrics parsed
  - `"fail"` — ran, its own threshold said no (`--require-exact` failures,
    FP rate over `--max-fp-rate`)
  - `"skipped"` — never launched: a DECLARED precondition (missing
    corpus/venv, `GF_SKIP_BENCHMARKS=1`, `GF_SKIP_RESTART=1`) failed
    BEFORE the run
  - `"error"` — the step RAN but exited nonzero without a threshold
    verdict, or its metrics could not be parsed from its log. A
    missing/unparseable metric on a step that ran is `"error"`, NEVER
    `"skipped"`.

With `GF_GATE=1`, `run_all.sh` exits nonzero if ANY step's gate is `"fail"`
OR `"error"`; `"skipped"` alone never fails (skips are declared, errors are
not). Default behavior is unchanged: report-only, exit 0.

```bash
GF_GATE=1 eval/run_all.sh http://127.0.0.1:8001
```

Gate logic lives in `eval/lib_summary.py` (`build_summary` /
`overall_gate`), unit-tested in `eval/test_run_all_summary.py`.

**Dialect/threshold pairing caveat:** the in-suite clean step gates against
the 13.6% ceiling derived from `clean_baseline.json`, which was measured
under `GF_HARPER_DIALECT=british` (+ the dialect spelling guard) — but
`run_all.sh` runs clean against whatever dialect the target bridge is
configured with. On an american-configured bridge (the golden/benchmark
config) the clean step reads high (~16% observed 2026-07-11) and can fail
the gate spuriously; that is a threshold-pairing artifact, not a
regression. The CANONICAL clean-FP gate is the separate british-configured
run (§4/§6). Treat an in-suite clean "fail" on an american bridge as
informational; never compare FP numbers across dialect envs (§4).

## 9. Recall measurement matrix

Phase-3 measurement matrix, run 2026-07-11 at bridge commit `ead7995` on
`gf-bridge-eval` (american unless noted, cold `gf-llamacpp` restarts per §1's
protocol, one flag on per run). Candidate criteria (from the P2-P4 plan):
golden 125/125, clean-FP (british re-run) ≤ 13.6%, CoNLL F0.5 ≥ 60.63 OR
JFLEG GLEU ≥ 0.4180, golden p50 ≤ 150ms for context/multi-pass (N-best is
exempt from the p50 ceiling — an opt-in quality knob priced at ~k× LLM
latency, never a default candidate).

| Metric | run0 (all off) | `GF_LLM_SENTENCE_CONTEXT` | `GF_GECTOR_PASSES=2` | `GF_LLM_NBEST=3` |
|---|---|---|---|---|
| Golden (american) | 125/125 | 125/125 | 125/125 | **123/125 ✗** |
| CoNLL-14 F0.5 (P/R) | 60.78 (64.84/48.59) | 60.78 (64.84/48.59) | 60.82 (64.88/48.65) | 60.56 (64.59/48.46) |
| BEA-19 F0.5 | 42.51 | 42.51 | 42.35 | (timeout) |
| JFLEG GLEU | — | 0.4107 | (timeout) | (timeout) |
| Clean-FP british | — | 11.6% ✓ | 11.6% ✓ | 11.0% ✓ |
| Golden p50 | 95.8ms | 108.4ms ✓ | **152.8ms ✗** | **250.0ms ✗** |

**Verdicts (code defaults did NOT flip — Global Constraints):**

- **`GF_LLM_SENTENCE_CONTEXT` — eligible for operator enable; benefit
  unmeasured-by-design on current instruments.** Passes every criterion
  (golden ✓, clean ✓, CoNLL 60.78 ≥ 60.63 ✓, p50 108.4ms ≤ 150ms ✓). CAVEAT:
  the measured quality delta is ZERO because every instrument (golden,
  CoNLL, JFLEG, clean corpus) is single-sentence — the ±1-context path never
  activates, so this matrix proves no-regression + the latency cost
  (+12.6ms p50), NOT a gain. Any real gain would only show on
  multi-sentence live text.
- **`GF_GECTOR_PASSES=2` — stays OFF: cost without measurable gain.** Fails
  the p50 ceiling (152.8ms > 150ms) with a noise-level quality delta
  (+0.04 CoNLL F0.5, −0.16 BEA-19).
- **`GF_LLM_NBEST=3` — refuted for enablement (negative result, recorded
  per the plan's abort path).** REAL majority-vote regression on golden:
  confusable `#106` (discrete→discreet) and `#107` (Whose→Who's,
  complement→compliment) are correctly fixed by the single-sample
  temperature-0 path but voted away in the merge — 2 of 3 temperature-0.3
  samples miss them and the majority kills the fix. Also p50 250ms. The
  code stays merged-but-dark.

Run notes: (1) run0's CoNLL 60.78 vs the plan's pinned 60.53 baseline is
llama.cpp cold-restart GPU nondeterminism (known noise band), not drift —
same build, flags off. (2) The `GF_GATE=1` exit-1s on the context/gector2
runs came from the in-suite AMERICAN clean run tripping the british-derived
13.6% threshold (see the dialect note in §8) — the canonical british
clean-FP re-runs all passed. The nbest3 run's gate failure was the real
golden regression.

## 10. Per-rule over-edit study

(Verdict recording home for the Phase-4 per-rule fired-pair-conditioned
threshold study — populated by `overedit_rule_study.py`.)

## 11. Confidence calibration (`calibration_eval.py`)

Every row `run_eval.py` writes to `results.json` carries a `score` field (0-100, the
model's own confidence) alongside `pass` (exact-match correctness). `calibration_eval.py`
buckets rows by score into a **reliability table** (10-pt buckets, mean confidence vs
empirical pass rate per bucket) and reports **Expected Calibration Error (ECE)** — the
weighted-average gap between predicted confidence and observed accuracy. This is the ONE
script in this harness that needs no bridge/LLM call at all — it runs entirely offline
against an existing `results.json`:

```bash
python3 eval/calibration_eval.py results.json
```

Prints the table + ECE and persists both to `eval/calibration_results.json`. **Caveat:**
the golden set is currently 125/125, so every bucket's empirical accuracy is 1.0 — ECE
against it only measures "does the model say 100 when it's always actually right," not
true discrimination between confident-and-wrong vs confident-and-right. A calibration
study with real diagnostic power needs a mix of passing AND failing rows (e.g. run against
a harder/adversarial cases file, or a CoNLL/BEA-derived per-sentence score if the bridge
ever surfaces one there). Read the current ECE as "how far off is the model's stated
confidence from 100% on a near-saturated set," not as a general trustworthiness verdict.

## 12. Dialect matrix (`dialect_matrix.py`)

Replaces the "never compare FP numbers across dialect envs" footgun (§4) with a script
that runs golden + clean-text-FP against BOTH an american-configured and a
british-configured bridge deployment in ONE invocation, reporting them side by side:

```bash
python3 eval/dialect_matrix.py http://127.0.0.1:8000 http://127.0.0.1:8001 \
    golden.jsonl clean_corpus.jsonl
```

(bring up a second bridge container with `-e GF_HARPER_DIALECT=british` on the second
port first — see §6's `gf-bridge-eval` recipe for the docker pattern.) Prints one table
with a column per dialect (golden pass-rate, clean FP-rate, per-category golden pass-rate,
p50 latency) and persists the full detail to `eval/dialect_matrix_results.json`. This
script cannot be run live in an environment with no bridge — its test suite
(`test_dialect_matrix.py`) mocks the bridge call to verify the two-dialect wiring and
report formatting; the actual dialect comparison needs a live run against two bridge
deployments.

## 13. Turnkey re-run (`run_all.sh`)

A single entrypoint that runs the full documented cold-restart protocol (§1) end to end:
golden → clean → conll14 → bea19 → jfleg → calibration, in that order, persisting every
artifact and printing a one-screen summary table.

```bash
eval/run_all.sh http://127.0.0.1:8000
```

- Cold-restarts the LLM backend (`docker compose restart llamacpp && sleep 25`) unless
  `GF_SKIP_RESTART=1` (e.g. the caller already restarted, or the bridge isn't a local
  docker-compose deployment).
- Records a timestamp + bridge commit hash (`-dirty` suffixed if `bridge/` has
  uncommitted changes — worth knowing when reading a number next to a benchmark commit).
- Each step is best-effort: a missing gitignored corpus (conll14/bea19 need
  `get_benchmarks.sh`; jfleg needs its manual fetch recipe in §2) is reported as SKIPPED,
  not fatal, so a quick smoke run without the academic corpora still exercises
  golden/clean/calibration. Set `GF_SKIP_BENCHMARKS=1` to skip conll14/bea19 on purpose.
- Prints a per-step status table (`ok` / `fail(rc=N)` / `skipped`) and writes
  `eval/run_all_summary.json` (timestamp, bridge commit, bridge URL, per-step headline
  metrics + gate state — see §8 — and the list of per-step artifact files to inspect:
  `results.json`, `results.latency.json`, `clean_corpus.runs.json`,
  `benchmarks/conll14/conll14_results.json`, `benchmarks/bea19/bea19_results.json`,
  `jfleg_results.json`, `calibration_results.json`).
- Set `GF_GATE=1` to turn the report into an enforced gate (§8).

This is orchestration over already-tested scripts (each step's own logic has its own unit
tests) — `run_all.sh` itself needs a live bridge + docker to verify end to end; it was only
syntax-checked (`bash -n`) in an environment with no bridge/LLM.
