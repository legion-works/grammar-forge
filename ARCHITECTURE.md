# Architecture

## Pattern Overview

**Overall:** Layered, transport-agnostic core with thin adapter transports, in-process fast-path models, and a sentence-segmented escalation pipeline backed by a per-sentence LRU cache, with optional post-LLM semantic verification and personalization-driven reject suppression at the finalize stage.

**Key Characteristics:**
- Transport-agnostic core (`internal/correction`) is never imported by HTTP/gRPC/DB code paths; adapters depend inward via the `correction.Service` interface only.
- Fast path runs in-process (`Harper` CGo + `GECToR` ONNX via `hugot`); LLM is escalation-only, called on the ORIGINAL text (not the fast-path-corrected text) so the LLM can override confident-wrong fast edits.
- Sentence-segmented pipeline: input is split into sentences via a punkt tokenizer; each sentence is checked independently and memoized in a per-sentence LRU cache; per-sentence spans are shifted back to whole-text offsets before being returned.
- Deterministic text-level repair chains run on the LLM output BEFORE diffing (over-edit repair, a/an article fix, optional dialect-spelling revert), because the diff fuses wanted and unwanted edits into single suggestions.
- Optional MiniLM semantic-verifier gate (`GF_SEMANTIC_VERIFIER`, OFF by default) discards LLM rewrites whose cosine similarity to the original falls below the threshold; the gate fails OPEN on every error condition and on a nil verifier, so it can never produce a false-positive on its own.
- Optional reject suppression (`GF_REJECT_SUPPRESSION`, OFF by default) drops at finalize the suggestions whose (word-original, word-suggestion) pair matches the user's rejected personalization list, hardening the prompt-level "Do NOT change" lines against LLM non-compliance.
- Bridge suggests, never mutates: clients apply suggestions locally via overlay/popover with a configurable accept hotkey.

## Layers

**Correction core (transport-agnostic):**
- Purpose: Domain types and the orchestration pipeline (fast path → escalation → finalize), plus LLM-only endpoints (rephrase, tone, completion). NEVER imports a transport, DB, or model backend directly.
- Location: `bridge/internal/correction/`
- Contains: `service.go` (orchestrator + singleflight dedup at both sentence and whole-text level + concurrent-correctors `runFast`), `routing.go` (escalation policy + merge, incl. trusted-category exemption), `interfaces.go`/`types.go` (domain types incl. `Prompt.Temperature`, `Source`, and `IsTrustableCategory`), `segment.go` (sentence segmentation), `diff.go` (LLM output → suggestions), `sentence_cache.go` (per-sentence LRU + `stats()` hit/miss counters), `complete.go` (LLM-only completion entry point, sources the per-source+text cache), `complete_cache.go` (per-source+text LRU + `stats()` — only LLM-call elision on /complete since there is no fast path), `cache_metrics.go` (`CacheMetrics` + `CacheStat` + local `breakerStater` interface for opportunistic LLM-breaker introspection — aggregated sentence/tone/complete hit/miss + singleflight dedup count + LLM breaker state, surfaced via `Service.CacheMetrics()` and inlined into `/stats`), `tone_cache.go` (per-text tone LRU + `stats()`), `overedit.go`/`article.go`/`irregular_plural.go`/`capitalization.go`/`dialect_repair.go` (text-level repair chains; `dialect_repair.go` is appended when `GF_DIALECT_SPELLING_GUARD` is on and `HarperDialect == "british"`), `dialect_lexicon.go` + embedded `dialect_lexicon_british.txt` (lazily-parsed VarCon-derived lexicon parsed via `sync.Once`), `suppression.go` (TTL-cached `RejectSuppressor` over the personalization reject pairs), `rephrase.go`/`tone.go`/`tone_parse.go` (LLM-only endpoints). Each non-trivial file has a co-located `*_test.go`.
- Depends on: nothing outside `correction` and standard library.
- Used by: `bridge/internal/restserver/`, `bridge/internal/ltcompat/`, `bridge/internal/ltgrpc/` (all via the `correction.Service` interface).

**LLM transport:**
- Purpose: Render prebuilt `Prompt` values to OpenAI-compatible or Anthropic wire endpoints.
- Location: `bridge/internal/llm/`
- Contains: `client.go` (OpenAI-compatible `chat` and `completions`), `anthropic.go` (Anthropic Messages API), `resilience.go` (bounded transient retry + consecutive-failure circuit breaker, shared by `Client` and `AnthropicClient` via `executeWithResilience` — retry on 429 + 5xx only; 4xx other than 429 is permanent and not retried; truncation is handled by the caller AFTER a 200 and is never retried). Co-located `client_test.go` / `anthropic_test.go` cover retry recovery, non-transient 4xx passthrough, breaker open/half-open state transitions, and the breaker-open fast-fail error.
- Depends on: `correction` (for `LLMClient`/`Prompt` interface).
- Used by: `bridge/cmd/grammarforge/main.go` (wires the default `llm.Client` plus the rephrase factory).

**Prompt builder:**
- Purpose: Translate a `Request`/`RephraseRequest`/`ToneRequest`/completion text into the model-family-specific prompt. Branches on `LLMFormat` (`chat_instruct` vs `grmr_native`); injects the personalisation few-shot block, the user-dictionary protected-vocabulary sentence when set, the dialect spelling instruction when `GF_HARPER_DIALECT` is non-American, and the source-scoped completion system prompt (OpenCode gets a coding-agent-instruction variant; every other client gets standard prose).
- Location: `bridge/internal/prompt/`
- Contains: `builder.go` (Build / BuildRephrase / BuildStyle / BuildWithSpellingHints / BuildTone / BuildComplete; `SetVocabularySource`, `SetDialect`), `builder_test.go`, `personalization_test.go`.
- Depends on: `correction`, `personalization`.
- Used by: `bridge/cmd/grammarforge/main.go` (constructed once, wired with personaliser + dictionary vocabulary + `cfg.HarperDialect`, injected into the service).

**Personalisation:**
- Purpose: TTL-cached snapshot of the accept/reject signal log rendered as the few-shot block appended to the chat system prompt. Read-only consumer; never blocks a correction on a slow store.
- Location: `bridge/internal/personalization/`
- Contains: `cache.go`.
- Depends on: `correction.Store`.
- Used by: `prompt.Builder`.

**Store (SQLite signal log):**
- Purpose: Persist correction events, per-edit rows, and user signals. Pure-Go driver (`modernc.org/sqlite`) — no third CGo dep.
- Location: `bridge/internal/store/`
- Contains: `sqlite.go` (schema, `LogCorrection`, `LogSignal`, `CountSignals`, `CountStatsExtended`, `PersonalizationExamples`, `LogTone`).
- Depends on: `correction` (implements `correction.Store`).
- Used by: `bridge/cmd/grammarforge/main.go`, `personalization`.

**Fast-path correctors:**
- Purpose: Two in-process engines. `Harper` (Rust `harper-core` via `hippietrail/harper-c` CGo, ~10ms warm) for spelling/style/punctuation; `GECToR` (RoBERTa-large ONNX via `hugot`, INT8 ~25ms CPU) for structural grammar.
- Location: `bridge/internal/harperffi/` and `bridge/internal/gector/`
- Contains: `harperffi/harper.go` (`//go:build cgo`, wraps `libharper_c.so`), `gector/gector.go` (`//go:build cgo && ORT`, wraps ONNX Runtime). Build with `-tags ORT` for the real binary; a stub (`bridge/cmd/grammarforge/fastpath_stub.go`, `//go:build !cgo || !ORT`) returns no fast path for CI builds so the service falls back to LLM-only.
- Depends on: `correction` (implements `correction.Corrector`).
- Used by: `bridge/cmd/grammarforge/main.go` via `buildFastPath(cfg)`.

**Semantic verifier (optional, ORT-gated):**
- Purpose: Optional post-LLM `correction.SemanticVerifier` gate. After the LLM output is repaired by `repairOverEdits` (and the a/an article fix), the verifier embeds both texts with all-MiniLM-L6-v2 (mean-pooled, L2-normalized) and rejects the rewrite when cosine similarity to the original falls below the threshold. OFF by default (`GF_SEMANTIC_VERIFIER`); enabling is an eval-gated operator action. The service fails OPEN on every error condition (nil verifier, non-positive threshold, verifier error, identical text); the gate only ever blocks on a confident low-similarity score.
- Location: `bridge/internal/semverify/` and `bridge/cmd/semverify-probe/`
- Contains: `semverify/cosine.go` (tag-free pure math + `cosine_test.go`), `semverify/semverify.go` (`//go:build cgo && ORT`, owns one `hugot` session + the `FeatureExtractionPipeline`, satisfies `correction.SemanticVerifier`), `semverify/semverify_ort_test.go`. `bridge/cmd/semverify-probe/` is a separate binary (`//go:build cgo && ORT`) that runs the same pairs the Python calibration script scored and emits `id<TAB>cosine` TSV for downstream diff — used to verify Python↔Go equivalence within ~0.02 per pair.
- Depends on: `correction` (implements `correction.SemanticVerifier`), `hugot` (ONNX backend, same one GECToR uses).
- Used by: `bridge/cmd/grammarforge/main.go` via `buildSemanticVerifier(cfg)` (mirrors the `buildFastPath` shape — load failure logs Warn and returns `(nil, no-op)`, cleanup is always non-nil so `defer closeVerifier()` is unconditional). The Dockerfile builds `semverify-probe` alongside `grammarforge`; `scripts/fetch-models.sh` downloads the MiniLM model + tokenizer into `bridge/models/minilm/`.

**REST adapter:**
- Purpose: Thin HTTP transport. Maps JSON ↔ `correction.Service`. No business logic. Owns CORS, body limits, and request timeouts.
- Location: `bridge/internal/restserver/`
- Contains: `server.go` (mux + middleware), `handlers.go` (decode/serve per route), `server_test.go`, `handlers_test.go`.
- Depends on: `correction` (via the `CorrectionService` interface), `ltcompat`.
- Used by: `bridge/cmd/grammarforge/main.go` (`restserver.New`).

**LanguageTool compatibility adapter:**
- Purpose: Serve LT-compatible `POST /v2/check` + `GET /v2/languages` so existing LT-protocol clients (the legacy browser add-on, the LT Java backend on the optional compose profile) keep working.
- Location: `bridge/internal/ltcompat/`
- Contains: `handler.go` (mux + `handleCheck`/`handleLanguages`), `offsets.go` (byte-span → UTF-16 code-unit conversion).
- Depends on: `correction`.
- Used by: `bridge/internal/restserver/server.go` (mounted under `/v2/`).

**LanguageTool gRPC adapter:**
- Purpose: Implement LT's `MLServerProto` `RemoteRule` so an optional real-LT container (compose profile `languagetool`) can federate the bridge's matches.
- Location: `bridge/internal/ltgrpc/`
- Contains: `server.go` (registers `MLServerServer`, one `Match` call per request sentence), `mapping.go` (bridge `Suggestion` → LT `Rule`/`Match`), `pb/` (generated `ml_server_grpc.pb.go`, `ml_server.pb.go`).
- Depends on: `correction`, `pb`.
- Used by: `bridge/cmd/grammarforge/main.go` (`ltgrpc.NewServer(svc)`).

**Dictionary (user word list):**
- Purpose: One on-disk file (`/data/user-dict.txt`), two consumers — Harper's merged-dict (via hot-reload watcher) and the correction service's `WordAllowlist` (suppresses LLM re-flags).
- Location: `bridge/internal/dictionary/`
- Contains: `dictionary.go`, plus the `harperffi` watcher (`userdict_watch.go`).
- Depends on: nothing.
- Used by: `bridge/cmd/grammarforge/main.go`, `bridge/internal/restserver/`.

**Thesaurus (offline synonyms):**
- Purpose: Moby Thesaurus II lookup backing `GET /synonyms`. Loaded once at startup; missing file is a no-op.
- Location: `bridge/internal/thesaurus/`
- Contains: `thesaurus.go` (in-memory frozen lookup map), `testdata/`.
- Used by: `bridge/cmd/grammarforge/main.go` (`thesaurus.Load`).

**Config:**
- Purpose: All bridge runtime settings from env (`GF_*`). Secrets only from env, never logged.
- Location: `bridge/internal/config/`
- Contains: `config.go` (`FromOS`, `Config` struct).
- Used by: `bridge/cmd/grammarforge/main.go` (`config.FromOS`).

**Browser client (WXT MV3 extension):**
- Purpose: In-page overlay + hotkey surface for any rich-text input on any site. Single content-script orchestrator wires `input → api → overlay → signal`; per-feature modules in `src/overlay/`, `src/input/`, `src/lib/`, `src/hotkeys/`, `src/storage/`, `src/signal/`.
- Location: `clients/browser/`
- Contains: `src/entrypoints/{background,content,options,popup,settings}/`, `src/api/` (`client.ts`, `sse.ts`, `types.ts`, `offset.ts`, `category.ts`, `url.ts`), `src/overlay/` (popover, panel, highlight, rephrase-card, status-button, goals, stats-view, synonyms, toast, tooltip, shadow-host, native-highlight, scanline), `src/input/` (observer, paste-guard, text, attachment, debounce, detector, undo-redo, caret-offset, rich-editor-apply, main-world-apply), `src/lib/` (pipeline, view-model, undo, word-diff, scoped-clear, check-seq, debug-backends, debug-log), `src/hotkeys/`, `src/messaging/`, `src/signal/queue.ts`, `src/storage/settings.ts`.
- Depends on: `BridgeClient` (`src/api/client.ts`) over `fetch`.
- Used by: end users (MV3 install on Chrome/Firefox).

**Vencord client:**
- Purpose: Vencord userplugin targeting Discord composer. Reuses browser-client layers via shared concepts (paste-skip, slate-apply, dictionary, rephrase, settings). Built and synced to a local Vencord checkout via `scripts/build.mjs` + `scripts/sync-to-vencord.mjs`.
- Location: `clients/vencord/`
- Contains: `src/index.ts` (plugin entry + settings), `src/orchestrator.ts`, `src/chatbar.ts` + `src/chatbar-tooltip.ts` (chat-bar button with hover pill), `src/composer.ts`, `src/dictionary.ts`, `src/rephrase.ts`, `src/settings.ts`, `src/debug-log.ts`, `types/vencord/shims.d.ts`, `scripts/build.mjs`, `scripts/sync-to-vencord.mjs`.
- Depends on: Vencord APIs (`@utils/types`, `@api/Settings`, `@api/ChatButtons`); bridge REST via `fetch`.
- Used by: Discord users running Vesktop/Vencord with the local plugin sync.

**OpenCode client:**
- Purpose: TUI plugin for the OpenCode CLI. Renders a floating review card, a status-line under the prompt, and (when enabled) an inline Copilot-style completion ghost, all via the host's `solid-js` scheduler. Lives entirely under a single `tui()` registration.
- Location: `clients/opencode/`
- Contains: `src/tui-entry.tsx` (host entry, slot registration, JSX render for `PanelComponent` + `GhostComponent`), `src/orchestrator.ts` (controller: grammar check, rephrase, completion trigger / accept / dismiss), `src/details-panel.ts` + `src/details-panel-view.ts` + `src/details-state.ts` (panel state + view), `src/card-spec.ts` (card builder for suggestion + rephrase variants), `src/category-palette.ts` + `src/category-palette-sync.ts`, `src/hit-test.ts`, `src/display-width.ts` (bun-segment-based terminal column width), `src/overlay-anchor.ts` (`clampAnchor` for the floating card, `ghostAnchor` for the inline ghost — distinct: ghost pins to the caret's exact row, card flips above/below), `src/ghost-overlay.ts` (Path A self-render ghost bridge: `lineLooksUnfinished` heuristic + `joinContinuation` + ghost subscriber fanout), `src/status-line.ts` (terse single-line state machine: flagged / pinned / rephrase-loading / rephrase-result / completion / clear), `src/paste-mask.ts`, `src/part-filter.ts`, `src/feature-detect.ts`, `src/opencode-types.ts`, `src/debug.ts`, `scripts/build.mjs`, `scripts/smoke-panel-render.ts`, `scripts/smoke-slot-render.ts`. `HARNESS.md` is the live-verification runbook (deferred until the patched `feat/tui-prompt-facade` core is live-tested).
- Depends on: `@opentui/core`, `@opentui/solid`, `solid-js`, `@opencode-ai/plugin` (peer).
- Used by: OpenCode TUI users via the host's `tui()` plugin loader.

**Eval harness:**
- Purpose: Run the cold golden eval (`golden.jsonl`) plus the CoNLL-14, BEA-19, JFLEG benchmarks via ERRANT scoring, plus the clean-text false-positive eval against a known-clean corpus, plus the MiniLM semantic-verifier calibration + Python↔Go equivalence probe. Gates every change that touches the correction pipeline.
- Location: `eval/`
- Contains: `run_eval.py` (driver; supports `--require-exact` to exit 1 unless every case passed; `--runs` variance for clean/jfleg; ERRANT per-type P/R/F0.5 via `lib_errant_types`; latency percentiles via `lib_latency` plumbed into every bridge-calling script), `golden.jsonl`, `jfleg_dev.jsonl`, `benchmarks/` (downloaded by `get_benchmarks.sh`), `bea19_eval.py` (BEA-19 gold re-annotated through the same ERRANT version as hypotheses; old cross-version 14.53 kept behind `--legacy-gold`), `conll14_eval.py`, `jfleg_eval.py` (result persistence to `jfleg_results.json`), `errant_score.py`, `lib_m2.py`. Confidence-calibration chain: `calibration_eval.py` (ECE on `/correct` confidence values; per-bin counts + per-bin accuracy → `calibration_results.json`); dialect matrix runner: `dialect_matrix.py` (per-dialect accuracy sweep on the golden set); turnkey protocol: `run_all.sh` (golden + CoNLL-14 + BEA-19 + JFLEG + clean-FP + calibration + latency in one invocation; emits `run_all_summary.json`). Clean-text FP chain: `clean_corpus.jsonl` (155 known-clean sentences across `golden`/`casual`/`technical`/`british` registers, regenerated by `build_clean_corpus.py`), `clean_eval.py` (per-request error handling, per-model/per-category attribution, `--max-fp-rate` gate, exit 0 when below), `clean_baseline.json` (Phase-A baseline FP rate — gate PRs at `baseline + 2pp`), `build_clean_corpus.py` + `test_build_clean_corpus.py` + `test_clean_eval.py`. Semantic-verifier calibration chain: `verifier_calibration.py` (Python reference via `sentence-transformers/all-MiniLM-L6-v2`), `overedit_fixtures.jsonl` (34 pairs extracted from `overedit_test.go`), `verifier_calibration_scores.json` + `semverify_probe_scores.tsv` (Go reference from `semverify-probe`), `verifier_equivalence_check.py` + `verifier_equivalence_diff.json` (cross-check + Go-only threshold re-study + verdict). Each Python module has a co-located `test_*.py`.
- Depends on: ERRANT (`pip`/`uv`), `sentence-transformers` (for the Python calibration reference; caches under `eval/.huggingface_cache/`).
- Used by: maintainer before touching the fast path, the LLM default, the escalation chain, any of the repair chains, the verifier wiring, or the reject-suppression wiring. Each new repair rule MUST pass the full cold golden eval (`eval/run_eval.py --require-exact`) AND the clean-text FP eval at-or-below baseline before merge.

**Tests:**
- Purpose: Browser-side performance harness (NOT unit tests — vitest runs unit tests co-located with source).
- Location: `tests/perf/`
- Contains: `harness-wired.test.ts`, `profile-harness.ts`, `profile-harness.html`, `capture.mjs`, `README.md`, `last-run.json`.

## Data Flow

**Grammar correction (`POST /correct`):**

1. REST handler decodes JSON, enforces `maxRequestBodyBytes` (256 KiB) — `bridge/internal/restserver/handlers.go` (`handleCorrect`).
2. `Service.Correct` segments text via punkt — `bridge/internal/correction/service.go` (`Correct`, `SegmentSentences` in `segment.go`).
3. For each sentence, look up in `sentenceCache`; on miss, run `correctOnce`. Concurrent identical-key correctOnce calls collapse onto ONE execution via a `singleflight.Group` (`s.sf`); on a piggybacked hit the caller's `sfDedupCount` is incremented atomically — the dedup is invisible to the caller because the per-correction logging must still run, but it spares the LLM/credit cost when racing debounces fire on the same sentence — `bridge/internal/correction/service.go` (`sf` field doc, `correctOnce`). On the caller side, concurrent whole-text `Correct` calls with the same `(request-shape, text)` key dedupe at the WHOLE-text level too via the same `s.sf` group, applied just below the per-sentence boundary (`service.go` line ~485, `sf.Do`).
   1. `runFast` invokes every corrector CONCURRENTLY (one goroutine per configured corrector via `runFastConcurrent`) — byte-identical merge order to the serial loop because the per-corrector results are collected in ascending corrector-index order — then applies `repairIrregularPluralPossessive` and `dropMidSentenceCapitalization` per corrector and `mergeSuggestions` (greedy confidence-DESC dedup) — `bridge/internal/correction/service.go` (`runFast`, `runFastConcurrent`), `routing.go` (`mergeSuggestions`).
   2. `EscalationPolicy.ShouldEscalate` decides whether to call the LLM — `bridge/internal/correction/routing.go`. When `EscalateOnFastEdit` is on AND every fast suggestion's category is in `EscalationPolicy.TrustedCategories` (the union with the legacy `SkipLLMForSpellingOnly` → `[CategorySpelling]`), the LLM is skipped and the fast path is served directly (Grammar is never trustable; the routing check enforces the invariant defensively, the config parser enforces it at startup).
   3. On escalation: `llm.Complete(escalationPrompt)` is called against the ORIGINAL text; LLM output is repaired via the over-edit chain (`repairOverEdits` — includes the optional dialect-spelling revert when `GF_DIALECT_SPELLING_GUARD` is on and `HarperDialect == "british"`), then via the a/an article fix (`applyArticleFixes`); when the semantic verifier is configured (`SetSemanticVerifier`), the repaired output is cosine-scored against the original and discarded on a low-similarity result (preserving the fast-path set on the escalation branch; yielding an empty grammar result on the LLM-only branch); surviving output is diffed to suggestions via `diffToSuggestions`; Harper categories are re-attached onto overlapping edits (`propagateFastCategories`) — `bridge/internal/correction/service.go` (`correctOnce`), `overedit.go`, `article.go`, `dialect_repair.go`, `diff.go`, `routing.go`, `semverify/semverify.go`.
   4. Optional `appendStyleSuggestions` runs when `req.Picky == true`; style suggestions overlap-filtered against grammar edits.
4. `finalize` drops dictionary-allowlisted single-word edits (`dropAllowlisted`), drops rejected-personalization-pair edits via `RejectSuppressor.Suppressed` when configured (`SetRejectSuppressor`, `GF_REJECT_SUPPRESSION`), sorts suggestions by `Span.Start` ASC (stable), scores them, persists via `store.LogCorrection`, tags each suggestion with its edit row id — `bridge/internal/correction/service.go` (`finalize`).
5. JSON response: `{original, suggestions[], score}` (correction `Correction` shape).
6. Clients apply suggestions locally via overlay/popover; an accept/reject/ignore click posts to `POST /signal`, which calls `Service.Signal` → `store.LogSignal` — `bridge/internal/restserver/handlers.go` (`handleSignal`).

**LLM wire format selection:**
- `GF_LLM_FORMAT=grmr_native` → `prompt.Builder` renders the GRMR-V3 native completion format; `llm.Client` posts to `/v1/completions`.
- `GF_LLM_FORMAT=chat_instruct` (default) → `prompt.Builder` renders a chat-templated `system + user` block; `llm.Client` posts to `/v1/chat/completions`. `chat_template_kwargs:{enable_thinking:false}` is sent for reasoning-capable models.
- Both branches share `LLMClient.Complete(ctx, Prompt)` — the choice is captured in `Prompt.Template`.
- `Prompt.Temperature` is the sampling temperature the LLM client forwards to the wire. Correction / rephrase / tone leave it at the zero value (greedy — golden-eval stable, byte-identical wire payload). Completion sets a non-zero value (`GF_COMPLETE_TEMPERATURE`, default 0.4) so distinct inputs vary their continuations; the fixed `LLMSeed` keeps a given input's continuation stable across runs.

**Rephrase (`POST /rephrase`):**
1. `restserver.handleRephrase` decodes `rephraseRequest` — `bridge/internal/restserver/handlers.go`.
2. `Service.Rephrase` resolves the backend: `req.Override` → `s.rephraseDefaultBackend` → `s.llm` — `bridge/internal/correction/service.go` (`Rephrase`).
3. Up to 5 variants requested; non-empty unique responses returned as primary + alternatives. Surfaces LLM errors (no best-effort fallback). Does NOT log.

**Tone (`POST /tone`, off by default):**
1. `restserver.handleTone` decodes `toneRequest` — `bridge/internal/restserver/handlers.go`.
2. `Service.AnalyzeTone` resolves the backend (tone default → rephrase default → main LLM), checks the LRU `toneCache`, calls the LLM, parses the strict-JSON tag list, aggregates per-sentence tags for `granularity="sentence"`, and best-effort logs the event via `store.LogTone`. Backend/parse errors yield empty tags, never a 5xx.
3. The route returns 404 when `GF_TONE_ENABLED` is false.

**Completion (`POST /complete`, off by default):**
1. `restserver.handleComplete` decodes `completeRequest` (text required; optional `source`, `max_tokens`, `temperature`) — `bridge/internal/restserver/handlers.go`. Returns 404 when `GF_COMPLETE_ENABLED` is false.
2. `Service.Complete` looks up the per-(source+text) `completeCache` (`bridge/internal/correction/complete_cache.go`, content-addressed by `sha256(source|0|text)`). On a hit the memoized continuation is returned without an LLM round-trip. Temperature is NOT part of the cache key: the fixed `LLMSeed` makes one input map to one stable continuation, and caching keeps the ghost overlay from flickering on repeated pauses for the same text.
3. On a miss, `prompt.Builder.BuildComplete(text, source)` renders the chat prompt. The system prompt is source-scoped: `correction.SourceOpenCode` gets a coding-agent-instruction variant (`completeSystemPromptOpenCode`); every other source gets standard prose (`completeSystemPrompt`). The configured `GF_HARPER_DIALECT` seeds a spelling instruction (American/empty appends nothing — byte-identical to the pre-dialect baseline).
4. `Prompt.Temperature` resolves to the per-request `temperature` (when > 0) or `cfg.CompleteTemperature` (default 0.4). `llm.Client` forwards it on the wire.
5. Empty continuations are NOT cached (transient empty results stay retryable). Non-empty continuations are cached and returned.

**Synonyms (`GET /synonyms`):**
1. `restserver.handleSynonyms` → `Service.Synonyms` → `thesaurus.Lookup(word)`. Returns `[]` (always non-nil JSON) for unknown words, disabled feature, or nil thesaurus.

**Signal logging (`POST /signal`):**
1. `restserver.handleSignal` decodes `{id, signal}` — `bridge/internal/restserver/handlers.go`.
2. `Service.Signal` validates `signal ∈ {accepted, rejected, ignored}` and calls `store.LogSignal(correctionID, signal)`.

**Stats (`GET /stats`):**
1. `restserver.handleStats` returns the combined payload from `Service.CountCorrections`, `Service.CountSignals`, `Service.CountStatsExtended`, and `Service.CacheMetrics` — `bridge/internal/restserver/handlers.go`. `StatsExtended` is `top_issues` (per-category edit histogram) + `streak` (consecutive UTC days) + `words_this_week` (sum of word counts over the inclusive 7-day window). `cache_metrics` (the concurrency/resilience block, always inlined — never gated, mirrors the retention block's contract) is `CacheMetrics{sentence_cache, tone_cache, complete_cache (each `CacheStat{hits, misses}`)} + singleflight_dedup` + `llm_breaker_state` (`"closed"` / `"open"` / `"half_open"` when the configured LLM client implements the local `breakerStater` interface; `""` otherwise). A fresh install reports all-zero counters and empty breaker state — `bridge/internal/correction/cache_metrics.go`, `bridge/internal/llm/resilience.go` (`circuitBreaker.State`).

**Health (`GET /health`):**
1. `restserver.handleHealth` returns `{status:"ok", premium:true}` — used by bridge-native clients (Vencord, OpenCode, textchecker fork) to gate premium features.

**LT compatibility (`POST /v2/check`):**
1. `ltcompat.handler.handleCheck` parses the LT form-encoded request — `bridge/internal/ltcompat/handler.go`.
2. Calls `Service.Correct` per sentence.
3. Converts the bridge's byte-offset spans to UTF-16 code units (Java `String` semantics — the load-bearing detail of this adapter) and renders the LT `Matches` JSON shape including `software.premium` + per-rule `isPremium`. Zero-length insertions are widened onto an adjacent rune.

**gRPC RemoteRule (optional real-LT compose profile):**
1. `ltgrpc.Server.Match` iterates `req.GetSentences()`, calls `Service.Correct` per sentence, maps the result via `suggestionsToMatchList` — `bridge/internal/ltgrpc/server.go`, `mapping.go`.
2. Returns a `MatchResponse` with `SentenceMatches` aligned 1:1 with the request sentences (LT requires alignment; errors yield an empty `MatchList` to preserve alignment).

## Key Abstractions

**`correction.Service`:**
- Purpose: Single orchestrator owned by `main` and consumed by every transport. Exposes the LLM-only endpoints (`Rephrase`, `AnalyzeTone`, `Complete`) alongside the correction pipeline.
- Location: `bridge/internal/correction/service.go` (pipeline), `complete.go` (`Complete`), `tone.go` (`AnalyzeTone`), `rephrase.go` (`Rephrase`).
- Pattern: Constructor-injection of all dependencies (`PromptBuilder`, `[]Corrector`, `LLMClient`, `Store`, `baseModel`, `EscalationPolicy`); optional post-construction setters for hot-reloadable features (allowlist, repair chains, sentence cache, rephrase factory, thesaurus, tone cache / gate / default backend, completion cache / gate / default temperature). All transports depend on a small `CorrectionService` interface slice (`restserver`, `ltcompat`, `ltgrpc` each declare their own).

**`correction.Corrector`:**
- Purpose: Fast-path engine interface (`Name()`, `Correct(ctx, req) ([]Suggestion, error)`).
- Location: `bridge/internal/correction/interfaces.go`
- Pattern: One implementation per backend in its own package (`harperffi`, `gector`); `main` constructs them in `buildFastPath` under build tags.

**`correction.LLMClient`:**
- Purpose: Slow-path transport interface (`Complete(ctx, Prompt) (string, error)`).
- Location: `bridge/internal/correction/interfaces.go`
- Pattern: Pure transport — renders the prebuilt `Prompt` to wire, returns text. No prompt construction, no domain knowledge.

**`correction.PromptBuilder`:**
- Purpose: Translate `Request`/`RephraseRequest`/`ToneRequest`/completion text into a `Prompt` (system + user + stop + template + temperature). Branches on model family; empty `User` on GRMR-native acts as the skip signal so the service can short-circuit style/tone calls. The chat path also threads `GF_HARPER_DIALECT` (a non-American dialect seeds a "use <dialect> English spelling" instruction; American appends NOTHING so the golden-eval baseline stays byte-identical) and the user-dictionary protected-vocabulary sentence + personalisation few-shot block. Completion rendering is source-scoped — `correction.SourceOpenCode` gets a coding-agent-instruction variant; every other source gets standard prose.
- Location: `bridge/internal/correction/interfaces.go` (interface), `bridge/internal/prompt/builder.go` (impl).

**`correction.Store`:**
- Purpose: Persist correction events, per-edit rows, signals, tone events. Returns aggregated snapshots for `/stats` and personalisation.
- Location: `bridge/internal/correction/interfaces.go` (interface), `bridge/internal/store/sqlite.go` (impl, `modernc.org/sqlite`).

**`correction.Suggestion`:**
- Purpose: One proposed edit. Spans are byte offsets into the UTF-8 text (load-bearing for `applyAll`'s constant-time slice); clients convert to UTF-16 / character offsets as needed.
- Location: `bridge/internal/correction/types.go`
- Pattern: `Apply` is total and clamps on invalid spans; suggestions are always returned sorted by `Span.Start` ASC so `applyAll` can iterate last-to-first and keep earlier offsets valid.

**`EscalationPolicy`:**
- Purpose: Decide when the fast path is insufficient and the LLM should run. Encodes all measured spikes (`EscalateOnFastEdit`, `SkipLLMForSpellingOnly`, `MinWordsForEscalation`, `MinConfidence`, `MaxSentenceLen`) plus the Phase-B `TrustedCategories` set. When `EscalateOnFastEdit` is on AND every fast suggestion's category is in `TrustedCategories` (unioned with `[CategorySpelling]` when `SkipLLMForSpellingOnly` is on), the LLM is skipped and the fast path is served directly; Grammar (the empty string) is never trustable — enforced by `correction.IsTrustableCategory`, `config.ParseTrustedCategories`, and the routing-layer defensive guard (`everyCategoryTrusted` → `isCategoryTrusted`).
- Location: `bridge/internal/correction/routing.go`

**`SemanticVerifier`:**
- Purpose: Post-LLM meaning-similarity gate. `Similarity(ctx, original, corrected) (float64, error)` returns a score in `[0,1]`; the service compares against a configured threshold and discards the rewrite on low similarity. Fails OPEN on every error condition (nil verifier, non-positive threshold, verifier error, identical text); the gate only ever blocks on a confident low-similarity score.
- Location: `bridge/internal/correction/interfaces.go` (interface), `bridge/internal/semverify/semverify.go` (impl, `//go:build cgo && ORT`).

**`RejectSuppressor`:**
- Purpose: Personalization-driven drop filter applied at finalize time. Reports whether a (word-level original, word-level suggestion) pair is on the user's rejected list (built from `Store.PersonalizationExamples.Rejected`, `Count>=3`). TTL-cached with stale-while-revalidate: an expired snapshot is served immediately while ONE background goroutine refreshes it (single-flight, capped at 5s) — the request path never blocks on SQLite. Context-blind at the word-pair level (a rejected pair suppresses that edit in every sentence); off by default.
- Location: `bridge/internal/correction/suppression.go`; consumed via `Service.SetRejectSuppressor`.

**`OverEditRule` chain (extensible):**
- Purpose: Pure-string text-level repair rules run on the LLM output BEFORE diffing. Each rule is `func(original, corrected string) string`; rules are pure, no I/O, no errors. `DefaultOverEditRules()` returns the measured baseline (proximity-agreement flip, proper-noun comma restructure); operators append additional rules via `Service.SetOverEditRules` — the dialect-spelling guard (`NewDialectSpellingRepair` over the embedded VarCon-derived lexicon) is the canonical extension, gated on `(DialectSpellingGuard && HarperDialect == "british")`.
- Location: `bridge/internal/correction/overedit.go` (types + defaults), `bridge/internal/correction/dialect_repair.go` (VarCon-backed dialect rule).

**`CacheMetrics`:**
- Purpose: Aggregated concurrency/resilience snapshot for `/stats`. `CacheMetrics{sentence_cache: CacheStat, tone_cache: CacheStat, complete_cache: CacheStat, singleflight_dedup: uint64, llm_breaker_state: string}` — every field is nil-safe / best-effort (a never-wired cache reports a zero `CacheStat`; the breaker state is `""` when the configured `LLMClient` doesn't expose `BreakerState()` — a type assertion, not a mandatory interface, so the fakes used in `correction` package tests don't have to wire a breaker). Surfaced via `Service.CacheMetrics()` and inlined into the `/stats` response's `cache_metrics` block — additive, never gated, so a fresh install just reports zeros.
- Location: `bridge/internal/correction/cache_metrics.go` (types + `Service.CacheMetrics`), `bridge/internal/llm/resilience.go` (`circuitBreaker.State` + `*Client.BreakerState` / `*AnthropicClient.BreakerState`).

**LLM retry + circuit breaker (`llm.RetryConfig` / `llm.BreakerConfig`):**
- Purpose: Bounded transient retry (`RetryConfig{Enabled, MaxRetries, BaseDelay, MaxDelay}`) + consecutive-failure circuit breaker (`BreakerConfig{Enabled, FailureThreshold, Cooldown}`) wrapped around every LLM HTTP round-trip via `executeWithResilience`. Retry only triggers on `isTransientStatus` (HTTP 429 + 5xx; 4xx other than 429 is a permanent client-side problem and is never retried). Defaults are conservative: retry on (1 retry, 200-500ms jittered backoff) + breaker on (5 consecutive failures, 30s cooldown). The OPEN state fast-fails with a distinct `breakerOpenError` — a deliberate trade of latency for availability when a backend is genuinely down (a 30s HTTP timeout per request stacks unmanageably under load).
- Location: `bridge/internal/llm/resilience.go` (`RetryConfig`, `BreakerConfig`, `circuitBreaker`, `executeWithResilience`, `DefaultRetryConfig`, `DefaultBreakerConfig`, `breakerOpenError`, `*requestError`, `*statusError`, `isTransientStatus`, `jitterSleep`), `bridge/internal/llm/client.go` (`Client.retry`/`breaker` fields + `SetRetryConfig` / `SetBreakerConfig`), `bridge/internal/llm/anthropic.go` (mirrors `Client`). Wired in `bridge/cmd/grammarforge/main.go` (`llmRetryConfigFrom` / `llmBreakerConfigFrom` translators over `config.Config`'s `GF_LLM_RETRY_*` / `GF_LLM_BREAKER_*`).

## Entry Points

**Bridge binary:**
- Location: `bridge/cmd/grammarforge/main.go`
- Triggers: `task bridge:build` → `docker compose up` (or `./bin/grammarforge`).
- Responsibilities: Load config from env, open SQLite store, open user dictionary (best-effort, no-op on failure), build the fast-path correctors under the `cgo && ORT` build tag, parse + validate `GF_ESCALATION_TRUSTED_CATEGORIES` (CSV → `[]string` via `config.ParseTrustedCategories`, whole-variable rejected on any invalid token), construct the prompt builder with the personalisation cache + vocabulary source + `cfg.HarperDialect`, build the `correction.Service` with every repair chain wired (over-edit defaults + optional dialect-spelling guard appended when `GF_DIALECT_SPELLING_GUARD` is on and `HarperDialect == "british"`), the completion cache / temperature / gate wired from `GF_COMPLETE_*`, the semantic verifier wired when `GF_SEMANTIC_VERIFIER` is on (load failure logs Warn and degrades to nil — service fails OPEN), the reject suppressor wired when `GF_REJECT_SUPPRESSION` is on; the LLM client (default + rephrase/tone override factories) is given the SAME retry + breaker policy from `GF_LLM_RETRY_*` / `GF_LLM_BREAKER_*` knobs (`SetRetryConfig` / `SetBreakerConfig` in `bridge/internal/llm/client.go` + `anthropic.go` — defaults are retry on (1 retry, 200-500ms jittered backoff) and breaker on (5 consecutive failures, 30s cooldown)), start the gRPC `RemoteRule` server (goroutine), start the REST server (blocking). Pure wiring — no business logic.

**`semverify-probe` binary:**
- Location: `bridge/cmd/semverify-probe/main.go` (`//go:build cgo && ORT`)
- Triggers: `docker run --rm grammarforge-bridge:dev /usr/local/bin/semverify-probe <modelPath> <fixtures.jsonl> <golden.jsonl>` (per the recipe in `eval/README.md`).
- Responsibilities: Run the in-process MiniLM verifier against the same pairs the Python calibration script scored and emit `id<TAB>cosine` TSV to stdout for downstream diff. Used to validate that `sentence-transformers/all-MiniLM-L6-v2` (Python) and `hugot`'s ONNX backend (Go) agree within ~0.02 per pair — otherwise the Python study is not a valid substitute for the real bridge path. Fixture pairs tagged `f<index>`, golden pairs `g<id>`.

**Browser extension:**
- Location: `clients/browser/src/entrypoints/content/index.ts`
- Triggers: `wxt dev` / `wxt build`; loaded on `<all_urls>` at `document_idle`.
- Responsibilities: Sole wirer of `input → api → overlay → signal`. Every timer and listener registered with the WXT `ctx` for clean teardown. Plain TS + native DOM in an open shadow root — no React (MV3 startup budget).

**Vencord plugin:**
- Location: `clients/vencord/src/index.ts`
- Triggers: `pnpm sync` (runs `scripts/build.mjs` + `scripts/sync-to-vencord.mjs`); loaded by Vencord's plugin manager when enabled.
- Responsibilities: Lifecycle (start/stop), settings (`bridgeUrl`, `allowRemoteBridge`, `realtimeDelayMs`, `acceptHotkey`, `rephraseHotkey`, `checkPastedText`), chat-bar button insertion order. All behaviour lives in `orchestrator.ts`.

**OpenCode TUI plugin:**
- Location: `clients/opencode/src/tui-entry.tsx`
- Triggers: Loaded by the OpenCode host via the `tui` export; rendered by the host's `solid-js` scheduler. The host invokes the plugin as `tui(api, options, meta)` — `options` is forwarded to the orchestrator so the tui.json settings (`completionEnabled`, `bridgeUrl`, hotkeys) actually reach the plugin.
- Responsibilities: Slot registration for `home_prompt_right` and `session_prompt_right`; JSX render for `PanelComponent` (floating suggestion / rephrase card) and `GhostComponent` (inline completion ghost). Each mounted component owns its own `createSignal` and subscribes to the controller's `setView` / ghost fanout (so updates ride the host scheduler). The orchestrator owns the controller; the tui() registration does no business logic. `HARNESS.md` is the live-verification runbook.

## Error Handling

**Strategy:** Fail-soft on every internal step; surface errors only at the request boundary when there is no fallback.

- **Fast corrector error:** logged at `Warn`, skipped; the next corrector still runs. The fast-path pipeline degrades gracefully to whatever subset of correctors loaded successfully.
- **LLM escalation error:** logged at `Warn`; fast-path suggestions are served unchanged. The `suspiciouslyTruncated` defense-in-depth (input ≥200 bytes AND output < ½ input length) catches backends that fail to report `finish_reason`/`stop_reason` and prevents a truncated completion from being diffed into mass-deletion suggestions; the truncation check runs once AFTER the 200 (never retried — retrying at the same sampling settings would just regenerate the same-shape truncated output).
- **LLM transient retry budget exhausted:** the retry layer (`executeWithResilience` in `bridge/internal/llm/resilience.go`) makes at most `1 + MaxRetries` HTTP attempts on 429/5xx/network-level errors with jittered backoff inside `[BaseDelay, MaxDelay]`; once exhausted the final error is wrapped (`*requestError` / `*statusError`) and surfaced like any other LLM error above. The breaker has already recorded the failure by the time the function returns, so a flapping backend can fast-fail subsequent requests instead of stacking timeouts.
- **LLM breaker open:** `executeWithResilience` short-circuits via `breakerOpenError` (a distinct error type — `"<label>: circuit breaker open (backend failing repeatedly); fast-failing instead of stacking timeouts"`) WITHOUT a network round-trip; the caller maps it like any LLM error. Operationally this trades latency for availability: when the configured LLM is genuinely down, requests fall back to the fast path in <1ms instead of paying one full 30s HTTP timeout each.
- **Semantic-verifier error:** logged at `Warn`; the LLM output is passed through unchanged (the service fails OPEN). The gate only ever blocks on a confident low-similarity score; a broken verifier can never produce a false-positive on its own.
- **Reject-suppressor refresh error:** logged at `Warn`; the last-good pair set is kept and `builtAt` is reset so the next call retries. A persistent store failure must not silently turn suppression off forever, but also must not hot-loop the store on every keystroke the way a synchronous cache would.
- **Store error during logging:** logged at `Error`; the suggestions are returned without edit IDs (so `/signal` cannot reference them this request). Logging is best-effort — never fails the request.
- **Sentence-level error:** logged at `Warn`, sentence is skipped. Only when EVERY sentence failed does the aggregate surface an error so the LLM-only mode keeps its error contract.
- **Rephrase error:** surfaced to the caller (no fast path to fall back to; rephrase is a chat-model feature).
- **Tone error:** swallowed; tone is advisory — returns empty tags rather than failing the request.
- **Completion error:** surfaced to the caller (no fast path; completion is a chat-model feature). The handler maps it to `502 Bad Gateway`. Completion is never logged to the store (no signal lifecycle).
- **User dictionary missing/unwriteable:** logged at `Warn`, feature disabled (the `restserver` `/dictionary` routes 503, the LLM re-flag suppression is a no-op). Never crashes startup.
- **Thesaurus missing:** logged at `Warn`, `/synonyms` returns empty arrays until the operator runs `bridge/scripts/fetch-thesaurus.sh`. Never crashes startup.
- **Request body >256 KiB:** rejected by `MaxBytesReader`; handlers' `decodeStrict` maps the read error to `400 Bad Request`.
- **Truncated style output:** logged at `Warn`; the grammar result is returned unchanged.
- **Sentence cache write error:** none — the cache is in-memory.
- **Completion cache write error:** none — the cache is in-memory; empty continuations are not cached (transient failures stay retryable on the next request).

## Cross-Cutting Concerns

**Logging:** `slog.Default()` with a JSON handler on stdout (`bridge/cmd/grammarforge/main.go`). Level controlled by `GF_LOG_LEVEL` (`debug`/`info`/`warn`/`error`). Secrets (`api_key`, `LLMAPIKey`, `RephraseAPIKey`, `ToneAPIKey`) are NEVER logged — the `correction.Service.Signal` / `Rephrase` / `AnalyzeTone` paths take them as struct fields and never put them in a log record. LLM line output is suppressed (the `*slog.LevelWarn` minimum prevents accidental content leakage from default-info level).

**Caching:**
- Sentence cache (`bridge/internal/correction/sentence_cache.go`): per-sentence LRU keyed on `(baseModel, Build(req).System, sentence, picky)`. Capacity via `GF_SENTENCE_CACHE_SIZE` (default 0 = disabled). On miss the full `correctOnce` runs.
- Tone cache (`bridge/internal/correction/tone_cache.go`): per-text-unit LRU keyed on `(modelKey, text)`. Capacity via `GF_TONE_CACHE_SIZE` (default 512).
- Completion cache (`bridge/internal/correction/complete_cache.go`): per-(source+text) LRU keyed on `sha256(source|0|text)`. Capacity via `GF_COMPLETE_CACHE_SIZE` (default 512, 0 disables). Completion has no fast path, so this cache is the only LLM-call elision on `/complete`. Temperature is NOT part of the key (the fixed `LLMSeed` makes a given input map to one stable continuation). Source is part of the key because the completion prompt is source-scoped (OpenCode coding-agent vs prose). Empty continuations are not cached (transient empty results stay retryable).
- Personalisation cache (`bridge/internal/personalization/cache.go`): TTL-cached snapshot of the signal log read by the prompt builder; the prompt builder never blocks on a slow store.
- Reject-suppressor cache (`bridge/internal/correction/suppression.go`): TTL-cached, stale-while-revalidate snapshot of the user's rejected `EditPair`s (Count>=3), keyed with `Count` zeroed so map equality treats `Count>=3` and `Count>=7` as the same key. Capacity is unbounded; freshness is TTL-bounded (`GF_REJECT_SUPPRESSION_TTL_SECONDS`, default 300s). On expiry the prior set is served while ONE background goroutine refreshes (single-flight — N concurrent cold-window calls collapse to one store query). Refresh is detached from any caller context and capped at 5s.
- Semantic-verifier session (`bridge/internal/semverify/semverify.go`): one `hugot.Session` + one `FeatureExtractionPipeline` held for the process lifetime (released on shutdown via the `Close()` returned by `buildSemanticVerifier`). The verifier itself is not a cache — every LLM response incurs one ONNX forward pass — but the underlying embeddings are deterministic, so a verification-then-diffusion pipeline is idempotent under the request cache.
- User dictionary hot-reload (`bridge/internal/harperffi/userdict_watch.go`): mtime-checked on every read so external edits are picked up without a restart.
- Dialect lexicon (`bridge/internal/correction/dialect_lexicon.go`): the embedded VarCon-derived `dialect_lexicon_british.txt` is parsed lazily into a map on the first `BritishLexicon()` call and cached via `sync.Once`. Construction is on-demand: deploys that never call this (when `GF_DIALECT_SPELLING_GUARD` is off, or when the deploy is American) never pay the parse cost — the embed bytes are not parsed at startup.
- Singleflight dedup (`bridge/internal/correction/service.go`): `Service.sf` is a `golang.org/x/sync/singleflight.Group` wrapping both the per-sentence `correctOnce` AND the whole-text `Correct` path. Concurrent identical-key requests race onto ONE real execution; piggybacked callers atomically increment `sfDedupCount` (recovered by `Service.CacheMetrics()` as `singleflight_dedup`). The downstream logging (`finalize` → `store.LogCorrection`) still runs once per request — the goal is to avoid double-paying the LLM/CPU cost, not to silently merge audit rows.
- LLM retry + circuit breaker (`bridge/internal/llm/resilience.go`): one `circuitBreaker` per `*Client` / `*AnthropicClient` instance (the default backend and each rephrase/tone override each get their own — a dead override backend must not trip the default's breaker). The breaker's metrics-friendly state string is exposed via `BreakerState()` and consumed opportunistically by `Service.CacheMetrics()` through the local `breakerStater` interface — so `/stats` shows `"closed"` / `"open"` / `"half_open"` whenever an `llm.Client` (or Anthropic client) is wired, and silently omits the field for the fakes used in `correction` package tests. Retries (bounded, default 1 retry) and the breaker (default 5-consecutive-failure threshold, 30s cooldown) are off by default at the package layer but on by default at the binary — `main.go` wires `GF_LLM_RETRY_*` / `GF_LLM_BREAKER_*` knobs into every `New` / `NewAnthropic` call.
- LLM-idle behaviour is BACKEND-SPECIFIC, not owned by the bridge: llama.cpp keeps one small model resident; vLLM uses `/sleep`+`/wake_up` (requires `--enable-sleep-mode`); Ollama uses `keep_alive`. All are expected, none is a bug.

**Storage:**
- Correction events + edit-level signals: SQLite via pure-Go `modernc.org/sqlite` (NO CGo) at `GF_DB_PATH` (default `/data/corrections.db`). Schema: `corrections(id, ts, source, original, suggestion, model, rule_id, context, base_model, adapter)` and `edits(id, correction_id, span_start, span_end, original, replacement, model, category, rule_id, confidence, signal, signaled_at)` (one row per edit so `/signal` attributes to ONE edit). Indices: `idx_ts`, `idx_correction`, `idx_signal`. `store.PruneOlderThan(retentionDays)` runs on startup.
- User dictionary: one line per word at `GF_HARPER_USER_DICT_PATH` (default `/data/user-dict.txt`). Atomic writes (temp file + fsync + rename).
- Moby thesaurus: one-time load from `GF_THESAURUS_PATH`; in-memory frozen lookup map.
- All persistence paths under `data/`, `models/`, `adapters/`, `ngrams/` are gitignored. `models/` + `ngrams/` never committed.

**Privacy invariants:**
- NO telemetry, analytics, or cloud calls of our own on any correction path.
- The ONLY outbound traffic is to the user-configured LLM endpoint (`GF_LLM_BASE_URL`), defaulting to local llama.cpp in the compose stack.
- No auth, no multi-user machinery, no cloud sync.

**Build-tag split:**
- Real binary: `-tags ORT` with `CGO_ENABLED=1`, native libs in `bridge/native/`. `bridge/cmd/grammarforge/fastpath_ort.go` (build tag `cgo && ORT`) constructs Harper + GECToR AND the MiniLM semantic verifier (mirrors the corrector build pattern: load failure logs Warn and returns `(nil, no-op)`).
- CI / lite build: `bridge/cmd/grammarforge/fastpath_stub.go` (build tag `!cgo || !ORT`) returns no fast-path correctors and no verifier — service runs LLM-only. When `GF_SEMANTIC_VERIFIER=true` is set on a stub binary, the stub logs Warn so the misconfiguration surfaces in the boot log. Keeps `go build` green in environments without `libharper_c.so` or `libonnxruntime.so`.
- `semverify/cosine.go` is tag-free pure math so the package always compiles; the ONNX-backed `Verifier` lives in `semverify/semverify.go` behind `cgo && ORT` (same as GECToR).
- `cmd/semverify-probe/main.go` is built only with `-tags ORT` (same build-tag split as the bridge binary).

**Format conventions:**
- Bridge spans are BYTE offsets into UTF-8 text (load-bearing for `applyAll`).
- LT-compat adapter converts to UTF-16 code units (Java `String` semantics) — the single most important detail of `ltcompat`.
- `replacements` on a suggestion is always non-empty when there is an edit; clients render the first as "Apply" and the rest via a "Show N more" expander.
- Wire JSON shape is additive: `correction.Suggestion` omits `Category` when it is the empty string `CategoryGrammar` (back-compat for grammar suggestions); non-empty categories surface only on picky-mode style edits and the Harper-only spelling/punctuation/typography tags.