# Handoff: Legion redesign + bridge hardening — state and obligations

Everything described here is merged to `master` (the `redesign/legion-works` branch is historical; master is currently 2 commits ahead of its remote — pushing is your call). The design spec that drove the client work is committed at `handoff/`; the redesign zip itself is gitignored (`GrammarForge*.zip`).

## What landed

**Clients — the Legion Works redesign (spec: `handoff/README.md` → `INSTRUCTIONS.md`).**
All three clients use the Legion DS: cyan accent, dark ink `#0c1622` on primary buttons (never white on cyan), Space Grotesk / Geist Sans / JetBrains Mono (bundled via @fontsource, no CDN), the glass recipe, and the Forge Caret mark. `clients/browser/src/lib/legion-tokens.ts` is the single source for category/band/confidence/accent hex — every TS consumer imports it; `popup.css` and OpenCode's palette are pinned by sync tests. Category palette is unchanged by design.

**Clients — behaviors you must not regress:**

- `rich-editor-apply.ts`: apply success is *verified* (the replacement must land). It used to return true on any text change, corrupting undo and firing false `accepted` signals.
- `paste-mask.ts` (OpenCode): UTF-16-safe masking, and the orchestrator **fails closed** on length mismatch instead of sending unmasked paste content to the bridge. Privacy guarantee, regression-tested.
- Browser never attaches to password/email fields — unconditional gate in `input/detector.ts` incl. `autocomplete` hints, detach on runtime type-flips. Never make password exclusion settings-overridable.
- Synonyms live in the split rephrase control (✨ Rephrase | Synonyms); no auto-open on double-click. Segment enabled only for a single clean word.
- Vencord: Goals persist via `setGoals` → `settings.store`; `stop()` tears down all surfaces; default rephrase hotkey is `ctrl+shift+/` (Discord owns `ctrl+/`); `applySlateFix` is the only mutation path.
- Shared `panel.ts` `buildMarkImg` falls back to a data-URI — Vencord has no `browser.runtime`; never call it bare in shared modules.
- Placement: deliberate z-index ladder (highlight < orb < tooltip < control < panel < popover < toast, max-int only on the shadow host); orb hides off-screen; panel has `reposition()`; rephrase cards anchor to the selection rect.
- OpenCode rendering (fixed after live regressions — commit `f356a6b`): diff rows reserve arrow width; hint segments clip to one line (`overflow=hidden`, `wrapMode=none`, `flexShrink=0`); `computeCardWidth` treats 0/NaN terminal dimensions as "not ready" and uses the fixed width; every `<Show>` has a fallback (an orphan-text throw used to silently blank the panel). **Lesson: jsdom tests missed all of these. `clients/opencode/scripts/smoke-panel-render.ts` and `smoke-slot-render.ts` now mount through a real renderer — run them whenever `tui-entry.tsx` or `card-spec.ts` changes.**
- Conventions: measure rects *before* imperative overlay rebuilds (`handoff/INSTRUCTIONS.md §F`); entrance animations transform-only with `opacity:1` defaults; host chrome stays native; OpenCode guards (seq, ref-swap, stale-pin, part ranges) stay intact; every mutation shows a toast with Undo; dismiss fires `/signal {action:'rejected'}`.

**Bridge (commit `8b3b6c1`):** semverify mutex (was a data race — hugot pipelines are not thread-safe, mirror gector's lock); fast-path correctors run concurrently with byte-identical merge order; singleflight dedup of identical in-flight sentence and whole-text checks (shared results are defensively copied before span mutation); LLM retry (1 retry, transient-only: network/429/5xx) + circuit breaker (5 consecutive failures → 30s open → half-open probe), knobs `GF_LLM_RETRY_*` / `GF_LLM_BREAKER_*`, defaults on; cache hit/miss + dedup counts + breaker state on `/stats` under `cache_metrics`.

**Eval harness:** BEA-19 gold is now re-annotated through the same errant version as hypotheses — the old cross-version F0.5 (14.53) was a broken instrument and survives only behind `--legacy-gold`. CoNLL-14 and BEA-19 emit per-error-type P/R/F0.5 breakdowns. Every bridge-calling script records latency percentiles. New: `calibration_eval.py` (ECE from `results.json` — currently 0.0665, but golden is 125/125 so it lacks discriminative data), `--runs N` variance on clean/jfleg, `dialect_matrix.py`, JFLEG result persistence, and `eval/run_all.sh` (cold-restart protocol → all benchmarks → summary with timestamp + bridge commit).

## Verified state

Browser 992, Vencord 102, OpenCode 363 (vitest, tsc clean, oxlint clean); bridge 564 Go tests under `-race`; eval 66 pytest. lefthook gates the TS clients (oxlint + tsc) and the Go bridge. pnpm lockfile reconciled.

## Your obligations, in order

1. **Run `eval/run_all.sh` against the live bridge.** The committed CoNLL/BEA numbers (F0.5 60.86 / legacy 14.53, dated 2026-06-09) predate the over-edit filter AND all of the above; JFLEG has never persisted a score. Until this runs, nobody knows where the shipped pipeline stands. Also sanity-check golden stays 125/125 after the concurrency changes (designed byte-identical, determinism-tested, but the golden gate is the contract).
2. **Visual QA of the clients.** Zero pixels have been rendered outside the OpenCode smoke scripts. Load the extension, compare against `handoff/reference/*.dc.html`; verify Vencord in Discord; verify OpenCode live (pin, hints, fresh session — the exact regressions just fixed).
3. **The SOTA roadmap** (from the bridge/eval/pipeline audit; recall is the lever — CoNLL P 65.0 / R 48.5):
   - *Phase 2 — confidence economy:* Harper emits flat 0.95, LLM edits emit 0. Calibrate per-source/category confidence from the existing /signal accept/reject log, then make escalation selective (today: any fast edit escalates) and add a reranker.
   - *Phase 3 — recall:* pass ±1 sentence of context to the LLM (sentence isolation makes tense/pronoun errors invisible; `service.go` sends `text[seg.Start:seg.End]` bare); iterative GECToR passes (single-pass today); N-best LLM sampling with verifier/edit-count selection; verb-form vocab fallback via morphology.
   - *Phase 4 — precision that generalizes:* replace the six hand-written over-edit revert rules with a learned gate (per-rule verifier thresholds or the paired-feature classifier the eval README already names — the global-threshold study concluded "no safe threshold", separation −0.43). All 18 clean-text FPs are LLM-caused.
   - *Phase 5 — the real SOTA move:* a GEC-tuned local model (the bridge already speaks a "GRMR-native" completion format) trained on cLang-8/W&I, or a second GEC model with majority voting. Prompt surgery on a general instruct model will not close 61 → 66-69 F0.5. Longer-term: per-user LoRA from the signal loop (`Event.Adapter` is reserved for this).
4. **Known absences, never scoped:** OpenCode parity (Goals/Stats/streaming/score — documented as deliberate in `clients/opencode/HARNESS.md`), iframe support, i18n (English literals throughout).
