# Codebase Structure

## Directory Layout

```
grammar-forge/
├── bridge/                 # Go bridge: REST + gRPC + native LT-compat /v2/check + fast-path models
├── clients/
│   ├── browser/            # WXT MV3 browser extension (Chrome + Firefox)
│   ├── opencode/           # OpenCode TUI plugin (solid-js + @opentui/solid)
│   └── vencord/            # Vencord userplugin targeting Discord composer
├── config/                 # server.properties + remote-rules.json
├── eval/                   # Python golden + CoNLL-14 + BEA-19 + JFLEG benchmark harness
├── tests/perf/             # Browser-side performance harness
├── scripts/                # e2e.sh + fetch-models.sh
├── adapters/               # Phase-3 LoRA adapters (gitignored)
├── data/                   # corrections.db + user-dict.txt (gitignored, user text)
├── models/                 # GECToR ONNX + LLM GGUF + MiniLM semantic-verifier model (gitignored, never committed)
├── ngrams/                 # Optional LT n-gram dataset (gitignored, ~16 GB)
├── .opencode/              # Maintainer design docs (specs/, plans/, skills/, agents/, notes/) — gitignored
├── .github/workflows/      # CI: dorny/paths-filter → per-service matrix + ci-complete + gitleaks always-on
├── AGENTS.md               # Repo-wide agent instructions + per-service conventions
├── README.md
├── LICENSE
├── docker-compose.yml      # Bridge + llama.cpp (+ optional languagetool profile)
├── docker-compose.override.yml
├── Taskfile.yml            # Root Taskfile; fans out to bridge/Taskfile.yml
├── .env.example            # Placeholder env (no secrets); real .env is gitignored
├── .editorconfig           # Tabs for Go, 2-sp YAML/JSON, 4-sp Python/TS
├── .yamllint               # YAML lint config
├── .dclintrc               # docker-compose lint config
├── lefthook.yml            # Pre-commit: gitleaks + golangci-lint + yamllint + hadolint + buf + ruff + oxlint + commitlint
└── GrammarForge.zip        # Pre-built browser extension zip (release artefact)
```

## Directory Purposes

**`bridge/`:**
- Purpose: Go bridge — the core of the system. REST server (port 8000) + LT-compatible `/v2/check` + gRPC RemoteRule (port 8082). Native Harper + GECToR run in-process; LLM is escalation-only. Optional MiniLM semantic verifier gates LLM rewrites before diffing; optional reject suppressor drops finalized suggestions matching the user's rejected pair list; optional VarCon-derived dialect-spelling guard reverts LLM Americanization of British input.
- Contains: Go source under `cmd/` + `internal/`; native libs under `native/` (gitignored, vendored at build); models under `models/` (gitignored — GECToR, LLM GGUF, MiniLM); proto schema under `proto/`; per-service `Taskfile.yml`; `Dockerfile`; `buf.gen.yaml` + `buf.yaml` for gRPC codegen; `cover.out` (test coverage); `go.mod` + `go.sum`.
- Key files: `cmd/grammarforge/main.go`, `cmd/semverify-probe/main.go`, `internal/correction/service.go`, `internal/correction/complete.go`, `internal/correction/complete_cache.go`, `internal/correction/cache_metrics.go`, `internal/correction/routing.go`, `internal/correction/dialect_lexicon.go`, `internal/correction/dialect_repair.go`, `internal/correction/suppression.go`, `internal/semverify/semverify.go`, `internal/semverify/cosine.go`, `internal/restserver/server.go`, `internal/restserver/handlers.go`, `internal/ltcompat/handler.go`, `internal/ltgrpc/server.go`, `internal/config/config.go`, `internal/store/sqlite.go`, `internal/prompt/builder.go`, `internal/personalization/cache.go`, `internal/harperffi/harper.go`, `internal/gector/gector.go`, `internal/llm/client.go`, `internal/llm/anthropic.go`, `internal/llm/resilience.go`, `internal/dictionary/dictionary.go`, `internal/thesaurus/thesaurus.go`, `proto/ml_server.proto`.

**`bridge/internal/correction/`:**
- Purpose: Transport-agnostic correction core (the single source of truth for the pipeline).
- Contains: `service.go` (orchestrator + singleflight dedup at sentence + whole-text levels + concurrent-corrector `runFast`), `routing.go` (escalation policy + dedup, incl. trusted-category exemption), `interfaces.go` + `types.go` (domain types incl. `Prompt.Temperature`, `Source`, and `IsTrustableCategory`), `segment.go` (sentence segmentation), `diff.go` (LLM output → suggestions), `sentence_cache.go` + `tone_cache.go` + `complete_cache.go` (LRUs + `stats()` hit/miss counters), `complete.go` (LLM-only completion entry point), `cache_metrics.go` (`CacheMetrics` + `CacheStat` + `Service.CacheMetrics()` — aggregated concurrency/resilience block surfaced into `/stats`), `overedit.go` + `article.go` + `irregular_plural.go` + `capitalization.go` + `dialect_repair.go` (text-level repair chains), `dialect_lexicon.go` + embedded `dialect_lexicon_british.txt` (lazily-parsed VarCon-derived British lexicon, parsed via `sync.Once`), `suppression.go` (`RejectSuppressor` TTL-cached stale-while-revalidate over the personalization reject pairs), `rephrase.go` + `tone.go` + `tone_parse.go` (LLM-only endpoints). Each non-trivial file has a co-located `*_test.go` (e.g. `article_test.go`, `capitalization_test.go`, `complete_cache_test.go`, `diff_test.go`, `dialect_lexicon_test.go`, `dialect_repair_test.go`, `irregular_plural_test.go`, `overedit_test.go`, `routing_test.go`, `segment_test.go`, `sentence_cache_test.go`, `service_test.go`, `suppression_test.go`, `tone_cache_test.go`, `tone_parse_test.go`, `tone_test.go`, `types_test.go`).

**`bridge/cmd/grammarforge/`:**
- Purpose: Binary entry + fast-path build-tag split.
- Contains: `main.go` (wire everything — also translates `GF_LLM_RETRY_*` / `GF_LLM_BREAKER_*` into the SAME retry + breaker policy for the default + rephrase/tone override LLM clients), `fastpath_ort.go` (`//go:build cgo && ORT` → constructs Harper + GECToR AND the MiniLM semantic verifier via `buildSemanticVerifier`), `fastpath_stub.go` (`//go:build !cgo || !ORT` → returns no fast path and no verifier for CI/lite builds; logs Warn when `GF_SEMANTIC_VERIFIER=true` is set on a stub binary so the misconfiguration surfaces).

**`bridge/cmd/semverify-probe/`:**
- Purpose: Standalone probe binary (`//go:build cgo && ORT`) that runs the in-process MiniLM verifier against fixture + golden pairs and emits `id<TAB>cosine` TSV. Used by `eval/verifier_equivalence_check.py` to validate Python (`sentence-transformers`) ↔ Go (`hugot` ONNX backend) agreement within ~0.02 per pair.
- Contains: `main.go` (entry, pair loader, TSV emitter), `doc.go` (usage).

**`bridge/proto/`:**
- Purpose: Source `.proto` for the gRPC `MLServer` (LanguageTool's `RemoteRule`).
- Contains: `ml_server.proto`. Generated Go bindings land in `bridge/internal/ltgrpc/pb/` via `buf generate`.

**`bridge/native/`:**
- Purpose: Bundled native libraries for CGo builds (`libharper_c.so`, `libonnxruntime.so`). Gitignored — populated by the Docker build context.

**`bridge/scripts/`:**
- Purpose: Bridge-side helper scripts.
- Contains: `fetch-thesaurus.sh` (downloads Moby Thesaurus II), `build-dialect-lexicon.sh` (build-time-only maintainer script — downloads `varcon-2020.12.07.tar.gz` with a pinned SHA-256, verifies-before-extracts, filters VarCon's A/B-tagged cluster lines into the sorted `american<TAB>british` TSV at `bridge/internal/correction/dialect_lexicon_british.txt`; the runtime path never fetches VarCon at runtime or inside the Docker build).

**`clients/browser/`:**
- Purpose: WXT MV3 browser extension. Single content-script orchestrator (`src/entrypoints/content/index.ts`) wires `input → api → overlay → signal`.
- Contains: `src/entrypoints/` (background `background.ts`, content — multiple content scripts co-located under `src/entrypoints/content/` including the main orchestrator plus `apply-agent.content.ts` (MAIN-world cross-world apply installer, Chromium-only — guarded by `defineContentScript({ world: 'MAIN' })`), options, popup, settings — each a WXT entry), `src/api/` (REST + SSE client + URL helpers + `category.ts` consuming `lib/legion-tokens`), `src/overlay/` (popover, panel, highlight, rephrase-card, rephrase-button, status-button, goals, stats-view, synonyms, toast, tooltip, shadow-host, native-highlight, scanline, dismiss, diff-view, popover-helpers, light-dismiss, rect, styles), `src/input/` (observer, paste-guard, text, attachment, debounce, detector, undo-redo, caret-offset, rich-editor-apply, main-world-apply), `src/lib/` (pipeline, view-model, undo, word-diff, scoped-clear, check-seq, debug-backends, debug-log, `legion-tokens.ts` — single source of truth for `CATEGORY_COLOR`, `BAND_COLOR`, `CONF_COLOR` and the Legion accent palette; every other TS consumer imports its constants from here), `src/hotkeys/` (accept, rephrase-target, keydown-rephrase), `src/messaging/schema.ts`, `src/signal/queue.ts`, `src/storage/settings.ts` + `settings-core.ts` (cross-client-safe module that the shared `tsconfig.json` `@/*` alias exposes to Vencord/OpenCode; `storage/settings.ts` itself is extension-API-coupled and is deliberately omitted from the alias). `wxt.config.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `public/`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`. Co-located `*.test.ts` next to every non-trivial source file (`wxt-config-permissions.test.ts` pins `optional_host_permissions`, `popup-css-palette-sync.test.ts` guards the popup CSS palette against `lib/legion-tokens` drift). The `overlay/synonyms` module exposes an optional `clearRect` to the host so callers (Vencord) can pass the composer/toolbar rect the popover must clear. Fonts are bundled via `@fontsource` (Space Grotesk, JetBrains Mono, Geist Sans) — no external CDN references survive `wxt build`.
- Key files: `src/entrypoints/content/index.ts`, `src/api/client.ts`, `src/overlay/popover.ts`, `src/overlay/panel.ts`, `src/overlay/rephrase-card.ts`, `src/overlay/synonyms.ts`, `src/input/observer.ts`, `src/input/paste-guard.ts`, `src/lib/pipeline.ts`, `src/signal/queue.ts`, `src/storage/settings.ts`.

**`clients/opencode/`:**
- Purpose: OpenCode TUI plugin (loaded via the host's `tui()` slot; `@opentui/solid` JSX rendered by the host's scheduler). Renders a floating review card, a status-line under the prompt, and (when enabled) an inline Copilot-style completion ghost.
- Contains: `src/tui-entry.tsx` (host entry, slot registration, JSX render for `PanelComponent` + `GhostComponent`), `src/orchestrator.ts` (controller: grammar check, rephrase, completion trigger/accept/dismiss), `src/details-panel.ts` + `src/details-panel-view.ts` + `src/details-state.ts`, `src/card-spec.ts` (card builder for suggestion + rephrase variants, sized via `computeCardWidth` with explicit degenerate-dimension fallback), `src/category-palette.ts` + `src/category-palette-sync.ts`, `src/hit-test.ts`, `src/display-width.ts` (bun-segment terminal column width), `src/overlay-anchor.ts` (`clampAnchor` for the floating card, `ghostAnchor` for the inline ghost — degenerate-dimension safe), `src/ghost-overlay.ts` (Path A self-render ghost bridge: `lineLooksUnfinished` heuristic + `joinContinuation` + ghost subscriber fanout), `src/status-line.ts` (terse single-line state machine), `src/paste-mask.ts` (+ `paste-mask-failclosed` test proves the privacy-leak is closed on every error path), `src/part-filter.ts`, `src/feature-detect.ts`, `src/mouse-dispatch.ts` (pure mouse click/scroll dispatch matrix lifted out of `tui-entry.tsx`'s inline JSX closures into testable functions), `src/terminal-theme.ts` (best-effort dark/light detection via `theme.background`/`COLORFGBG` fallback for the status line + ghost text, which render with no card behind them), `src/opencode-types.ts`, `src/debug.ts`. `scripts/build.mjs`, `scripts/smoke-panel-render.ts` + `scripts/smoke-slot-render.ts` (both mount through a real renderer at degenerate sizes). `HARNESS.md` is the live-verification runbook (deferred until the patched `feat/tui-prompt-facade` core is live-tested). `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`.
- Key files: `src/tui-entry.tsx`, `src/orchestrator.ts`, `src/details-panel-view.ts`, `src/card-spec.ts`, `src/ghost-overlay.ts`, `src/status-line.ts`, `src/overlay-anchor.ts`, `src/display-width.ts`, `HARNESS.md`.

**`clients/vencord/`:**
- Purpose: Vencord userplugin targeting Discord composer. Built and synced to a local Vencord checkout.
- Contains: `src/index.ts` (plugin entry + settings), `src/orchestrator.ts` (selection-toolbar clearance — the synonyms popover must clear the floating B/I/U toolbar above the composer; the orchestrator extends the composer rect upward by `SELECTION_TOOLBAR_CLEARANCE_PX` (56px) and passes it as the optional `clearRect` so the popover clears both the word AND the host chrome; split rephrase/synonyms control + debounced selectionchange path mirror the browser client), `src/chatbar.ts` + `src/chatbar-tooltip.ts` + `src/chatbar-badge.ts` (chat-bar button with hover pill + corrections panel + pure badge-state derivation `count` / `pip` / `clean` / paused-hidden, exported so the unit test can exercise the fast-check pip without spinning up React/Vencord), `src/composer.ts`, `src/dictionary.ts`, `src/rephrase.ts`, `src/settings.ts`, `src/debug-log.ts`, `src/legion-palette.ts` (re-exports the dark-theme constants from `clients/browser/src/lib/legion-tokens.ts` under their historical names — single source of truth for category/band/confidence hex values), `types/vencord/shims.d.ts`, `scripts/build.mjs`, `scripts/sync-to-vencord.mjs`, `dist/` (built artefact, gitignored), `README.md`.
- Key files: `src/index.ts`, `src/orchestrator.ts`, `src/chatbar.ts`, `src/composer.ts`, `src/rephrase.ts`.

**`config/`:**
- Purpose: Bridge config files.
- Contains: `server.properties` (LT server config — only consumed by the optional real-LT compose profile), `remote-rules.json` (the `remoteRulesFile` JSON that points the optional LT container at the bridge's gRPC `RemoteRule`).

**`eval/`:**
- Purpose: Python benchmark harness. Gates every change that touches the correction pipeline.
- Contains: `run_eval.py` (driver; supports `--require-exact` to exit 1 unless every case passed; `--runs` variance for clean/jfleg; ERRANT per-type P/R/F0.5 via `lib_errant_types`; latency percentiles via `lib_latency` plumbed into every bridge-calling script), `golden.jsonl` (the in-house 125-case cold golden set), `jfleg_dev.jsonl`, `benchmarks/` (downloaded by `get_benchmarks.sh`; CoNLL-14 + BEA-19 raw + m2scorer; BEA-19 gold re-annotated through the same ERRANT version as hypotheses, with the original cross-version 14.53 preserved behind `bea19_eval.py --legacy-gold`), `bea19_eval.py`, `conll14_eval.py`, `jfleg_eval.py` (result persistence to `jfleg_results.json`), `errant_score.py` (ERRANT scoring), `lib_m2.py` (M² scorer), `lib_errant_types.py` (per-type P/R/F0.5), `lib_latency.py` (p50/p95/p99 across every bridge call). Confidence-calibration chain: `calibration_eval.py` (ECE on `/correct` confidence values + per-bin counts → `calibration_results.json`). Dialect matrix runner: `dialect_matrix.py` (per-dialect accuracy sweep). Turnkey protocol: `run_all.sh` (golden + CoNLL-14 + BEA-19 + JFLEG + clean-FP + calibration + latency in one invocation; emits `run_all_summary.json`). Clean-text FP chain: `clean_corpus.jsonl` (155 known-clean sentences across `golden`/`casual`/`technical`/`british` registers, regenerated by `build_clean_corpus.py`), `clean_eval.py` (per-request error handling, per-model/per-category attribution, `--max-fp-rate` gate), `clean_baseline.json` (Phase-A baseline FP rate — gate PRs at `baseline + 2pp`), `build_clean_corpus.py` + `test_build_clean_corpus.py` + `test_clean_eval.py`. Semantic-verifier calibration chain: `verifier_calibration.py` (Python reference via `sentence-transformers/all-MiniLM-L6-v2`), `overedit_fixtures.jsonl` (34 pairs extracted from `overedit_test.go`), `verifier_calibration_scores.json` + `semverify_probe_scores.tsv` (Go reference from `semverify-probe`), `verifier_equivalence_check.py` + `verifier_equivalence_diff.json` (cross-check + Go-only threshold re-study + verdict). `test_bea19_eval.py`, `test_conll14_eval.py`, `test_lib_m2.py`. `results.json`, `README.md`, `.venv/` (local venv, gitignored).

**`tests/perf/`:**
- Purpose: Browser-side performance harness (NOT unit tests — vitest unit tests are co-located with source).
- Contains: `harness-wired.test.ts`, `profile-harness.ts`, `profile-harness.html`, `capture.mjs`, `README.md`, `last-run.json`.

**`scripts/`:**
- Purpose: Repo-root helper scripts.
- Contains: `e2e.sh` (full end-to-end smoke against a live GPU host), `fetch-models.sh` (downloads GECToR + LLM GGUF + MiniLM semantic-verifier model + tokenizer into `bridge/models/`).

**`.opencode/`:**
- Purpose: Maintainer design docs, plans, skills, agents, notes. Gitignored — local to each maintainer checkout; never committed.
- Contains: `specs/` (authoritative spec drafts + spike writeups, e.g. `SPEC.md`, `2026-06-10-llm-bakeoff-4b-spike.md`, `2026-06-10-merge-not-replace-spike.md`, `2026-06-15-client-redesign/`, `2026-06-23-design-update/`), `plans/`, `skills/`, `agents/`, `notes/`, `magic-context/`, `node_modules/` (OpenCode's own plugin SDK — not project code), `package.json`, `package-lock.json`.

**`.github/workflows/`:**
- Purpose: CI configuration.
- Contains: `ci.yml` — `dorny/paths-filter` → per-service matrix → synthetic `ci-complete` required check; gitleaks always-on (even docs-only PRs).

## Key File Locations

**Entry Points:**
- `bridge/cmd/grammarforge/main.go`: Bridge binary — load config, wire dependencies, start gRPC + REST.
- `bridge/cmd/semverify-probe/main.go`: MiniLM probe binary — runs the in-process verifier against fixture + golden pairs and emits TSV for Python↔Go equivalence checking.
- `clients/browser/src/entrypoints/content/index.ts`: Browser content-script orchestrator (wiring only; logic lives in lower layers).
- `clients/vencord/src/index.ts`: Vencord plugin entry + settings.
- `clients/opencode/src/tui-entry.tsx`: OpenCode TUI host entry + slot registration.

**Configuration:**
- `bridge/internal/config/config.go`: Bridge env loader (`FromOS`).
- `.env.example`: Placeholder env (no secrets) — copy to `.env` and fill in.
- `config/server.properties`: LT server config (optional real-LT compose profile only).
- `config/remote-rules.json`: `remoteRulesFile` JSON (optional real-LT compose profile only).
- `clients/browser/wxt.config.ts`: WXT config (build sha + iso time injected as `__GF_BUILD_SHA__` / `__GF_BUILD_TIME__`).
- `docker-compose.yml`: Bridge + llama.cpp (+ optional `languagetool` profile).

**Core Logic:**
- `bridge/internal/correction/service.go`: Pipeline orchestrator (fast path → escalation → finalize); wires `Complete` / `Rephrase` / `AnalyzeTone` setter API, plus `SetSemanticVerifier` / `SetRejectSuppressor` / `SetOverEditRules` for the optional gates.
- `bridge/internal/correction/routing.go`: `EscalationPolicy` (incl. `TrustedCategories` set + legacy `SkipLLMForSpellingOnly`) + `mergeSuggestions` + `effectiveTrustedCategories` / `everyCategoryTrusted` defensive guards.
- `bridge/internal/correction/types.go`: Domain types (`Suggestion`, `Prompt`, `Span`, `Event`, `EditRecord`); `IsTrustableCategory` is the single source of truth for `GF_ESCALATION_TRUSTED_CATEGORIES` validity (Grammar is never trustable).
- `bridge/internal/correction/segment.go`: Punkt sentence segmentation.
- `bridge/internal/correction/diff.go`: LLM output → `Suggestion`s.
- `bridge/internal/correction/overedit.go`: LLM over-edit repair chain (`GF_OVEREDIT_FILTER`).
- `bridge/internal/correction/article.go`: Deterministic a/an article fix (`GF_ARTICLE_FIX`).
- `bridge/internal/correction/irregular_plural.go`: Harper irregular-plural possessive misfire repair (`GF_IRREGULAR_PLURAL_FIX`).
- `bridge/internal/correction/capitalization.go`: Harper mid-sentence capitalization misfire filter (`GF_CAPITALIZATION_FIX`).
- `bridge/internal/correction/dialect_lexicon.go`: Embedded VarCon-derived British lexicon (`dialect_lexicon_british.txt`, 12,888 pairs, lazily parsed via `sync.Once`); constructor is `BritishLexicon() map[string]string`.
- `bridge/internal/correction/dialect_repair.go`: `NewDialectSpellingRepair(lexicon)` — appendable `OverEditRule` reverting LLM Americanization of British input (`GF_DIALECT_SPELLING_GUARD`, British-only).
- `bridge/internal/correction/suppression.go`: `RejectSuppressor` — TTL-cached, stale-while-revalidate snapshot of the user's rejected `EditPair`s; `Service.dropRejected` widens suggestion spans to word boundaries before lookup.
- `bridge/internal/semverify/semverify.go`: MiniLM semantic verifier (`//go:build cgo && ORT`) — `Similarity(ctx, original, corrected) (float64, error)` over one `hugot` session.
- `bridge/internal/semverify/cosine.go`: Tag-free pure-math cosine similarity (always compiles).
- `bridge/internal/correction/sentence_cache.go`: Per-sentence LRU cache (`GF_SENTENCE_CACHE_SIZE`).
- `bridge/internal/correction/tone_cache.go`: Per-text-unit tone LRU cache (`GF_TONE_CACHE_SIZE`).
- `bridge/internal/correction/complete.go`: LLM-only `/complete` entry point — caches via `complete_cache.go`, threads per-request temperature, scoped by `Source`.
- `bridge/internal/correction/complete_cache.go`: Per-(source+text) LRU for completion (`GF_COMPLETE_CACHE_SIZE`); sha256(`source`+NUL+`text`) key; only LLM-call elision on `/complete` (no fast path).
- `bridge/internal/correction/rephrase.go`, `tone.go`, `tone_parse.go`: LLM-only endpoint types + parsers.

**Tests:**
- Bridge: co-located `*_test.go` next to every non-trivial file in `bridge/internal/`. Run via `task bridge:test` (real binary, `-tags ORT -race -cover`) or `task bridge:test-ci` (CI, non-CGo packages only).
- Browser: co-located `*.test.ts` next to every non-trivial file. Run via `pnpm test` (`vitest`) in `clients/browser/`.
- Vencord + OpenCode: co-located `*.test.ts`. Run via `pnpm test` in each.
- Eval: `eval/test_*.py` (synthetic — `test_bea19_eval.py`, `test_build_clean_corpus.py`, `test_calibration_eval.py`, `test_clean_eval.py`, `test_conll14_eval.py`, `test_dialect_matrix.py`, `test_jfleg_eval.py`, `test_lib_errant_types.py`, `test_lib_latency.py`, `test_lib_m2.py`). Run via `pytest` in `eval/`.
- Perf: `tests/perf/harness-wired.test.ts` (browser-side performance capture).

## Naming Conventions

**Files:** Lowercase, full words, single concept per file. Same name across Go/TS/Python where the concept is shared (correction, suggestion, signal, span, edit, fast-path, slow-path, sentence-cache, over-edit, escalate, apply). No cryptic abbreviations. Test files are co-located and end in `_test.go` (Go), `.test.ts` (TS), or `test_*.py` (Python).

**Directories:** Lowercase, no separators. `internal/` is Go-private (only imported by code under the same parent). `bridge/internal/<feature>/` is the bridge's sub-package layout. `clients/<client>/src/<concern>/` is the client-side convention (e.g. `clients/browser/src/api/`, `clients/browser/src/overlay/`, `clients/opencode/src/`). Specs and spike writeups under `.opencode/specs/<YYYY-MM-DD>-<topic>/` (newest first; co-located `handoff/` carries reference assets).

**Identifiers (repo-wide, all languages):**
- Greppable, full-word, unique — `handleCorrectRequest`, not `hndlReq`.
- No dynamic identifier construction (no string-concatenated function/route names, no reflection dispatch hiding call sites).
- Shared vocabulary: correction, suggestion, signal, span, edit, fast-path, slow-path, escalate, finalize, rephrase, tone, thesaurus, dictionary, allowlist.

## Where to Add New Code

**New LLM backend (e.g. a new provider for the rephrase factory):** Add a constructor in `bridge/internal/llm/` returning a `correction.LLMClient`, then register it in the switch in `bridge/cmd/grammarforge/main.go` (`SetRephraseFactory`).

**New fast-path corrector:** Create `bridge/internal/<name>/` with a type implementing `correction.Corrector` (`Name() Model`, `Correct(ctx, req) ([]Suggestion, error)`). Add `Model` + any new `Category*` constants in `bridge/internal/correction/types.go`. Wire it in `bridge/cmd/grammarforge/main.go` (`buildFastPath` under the `cgo && ORT` build tag) and add a stub for `!cgo || !ORT` builds. Mirror the existing `harperffi`/`gector` build-tag split.

**New text-level repair chain:** Add a function (or `OverEditRule` if it belongs in the LLM-output chain) to `bridge/internal/correction/` and call it from `bridge/internal/correction/service.go` (`correctOnce` or `repairOverEdits`). Gate on a new `GF_*` flag in `bridge/internal/config/config.go`; add a `Set*` setter on `correction.Service` and wire the flag in `main.go`. Every new repair rule MUST pass the full cold golden eval (`eval/run_eval.py --require-exact`, 125/125) AND the clean-text FP eval at-or-below `eval/clean_baseline.json` + 2pp before merge. The dialect-spelling guard (`NewDialectSpellingRepair` over the embedded lexicon) is the canonical appendable rule — see `bridge/internal/correction/dialect_repair.go` for the shape and `bridge/cmd/grammarforge/main.go` for the `(DialectSpellingGuard && HarperDialect == "british")` wiring.

**New semantic-verifier gate rule:** The MiniLM cosine gate is universal (one threshold covers every LLM rewrite class). A calibration study (golden + over-edit fixtures → cosine distribution) is REQUIRED before any operator enable — the Phase-C study in `eval/README.md` §5 found **NO SAFE THRESHOLD** (separation inverted: many over-edits score higher than the lowest golden corrections). The `correction.SemanticVerifier` interface, wiring, probe binary, and Python↔Go equivalence harness remain in the tree (gated to `cgo && ORT`, off by default); operator enablement is blocked until either a per-rule threshold or a paired-feature classifier replaces the universal gate. Reproducing the study uses `eval/verifier_calibration.py` + the `bridge/cmd/semverify-probe` binary + `eval/verifier_equivalence_check.py`.

**New trusted-category escalation exemption:** Add the new category to `correction.IsTrustableCategory` in `bridge/internal/correction/types.go` (Grammar — the empty string — is never trustable; that invariant is load-bearing). Wire the env CSV at `bridge/internal/config/config.go` (`ParseTrustedCategories`, which rejects empty tokens, the literal `"grammar"`, and unknown names by ignoring the WHOLE variable — a typo'd CSV must not silently produce a partial-subset foot-gun). Default `""` preserves legacy `SkipLLMForSpellingOnly` semantics; enablement is an eval-gated operator action — BOTH `eval/run_eval.py --require-exact` (125/125) AND `eval/clean_eval.py` at-or-below `baseline + 2pp` must pass on `gf-bridge-eval` before any candidate set goes live on a real deploy (recipe in `eval/README.md` §6).

**New REST route:** Add a `mux.HandleFunc` line in `bridge/internal/restserver/server.go` (`Handler()`). Implement `handle*` in `bridge/internal/restserver/handlers.go` and decode via the existing strict-decode helper. Extend `CorrectionService` in `server.go` with the smallest interface slice the new handler needs.

**New LT-compat endpoint:** Add a `mux.HandleFunc` line in `bridge/internal/ltcompat/handler.go`. Convert byte spans to UTF-16 via `bridge/internal/ltcompat/offsets.go` — never forget this; LT clients crash on byte offsets.

**New gRPC method:** Edit `bridge/proto/ml_server.proto`, then `buf generate`. Never hand-edit `bridge/internal/ltgrpc/pb/`.

**New bridge config knob:** Add a field to `Config` in `bridge/internal/config/config.go` (`FromOS` parses `GF_*` env). Default it to the legacy value so existing deploys stay byte-identical. Wire the consumer in `bridge/cmd/grammarforge/main.go`.

**New browser overlay widget:** Add `clients/browser/src/overlay/<name>.ts` + co-located `<name>.test.ts`. Mount it from `clients/browser/src/entrypoints/content/index.ts`. All overlays must live under an open shadow root (`clients/browser/src/overlay/shadow-host.ts`).

**New browser input handler:** Add `clients/browser/src/input/<name>.ts` + `<name>.test.ts`. Wire from `clients/browser/src/entrypoints/content/index.ts`. All timers/listeners must register with the WXT `ctx` for clean teardown.

**New Vencord feature module:** Add `clients/vencord/src/<name>.ts` + `<name>.test.ts`. Import from `clients/vencord/src/orchestrator.ts` or `clients/vencord/src/index.ts`. Run `pnpm sync` after edits.

**New OpenCode TUI view:** Add a new view to `clients/opencode/src/details-panel-view.ts` + state to `clients/opencode/src/details-state.ts` + card spec in `clients/opencode/src/card-spec.ts`. Mount the switch from `clients/opencode/src/tui-entry.tsx` (host entry).

**New eval benchmark:** Add a Python module under `eval/` (`<benchmark>_eval.py` + co-located `test_<benchmark>_eval.py`). Add a driver block in `eval/run_eval.py` and an entry in `eval/README.md`.

**New repair rule, new spike, new model default:** ALWAYS gate on the full cold golden eval (`eval/run_eval.py` against `eval/golden.jsonl`, 125 cases) AND, if the change touches the LLM or escalation path, the CoNLL-14 / BEA-19 / JFLEG benchmark ladder. Record the verdict in the relevant `.opencode/specs/<YYYY-MM-DD>-*.md` writeup.

**Shared utilities:** Anything shared across Go services lives in `bridge/internal/correction/` (transport-agnostic types) or a sibling `bridge/internal/<util>/` package. Anything shared across the browser client lives in `clients/browser/src/lib/` (e.g. `pipeline.ts`, `view-model.ts`, `undo.ts`). `clients/browser/src/` is the canonical home of these shared modules — Vencord and OpenCode do NOT fork or reimplement them. Instead `clients/vencord/tsconfig.json` and `clients/opencode/tsconfig.json` both alias `"@/*"` to `../browser/src/*` and directly import from `api/`, `lib/`, `signal/`, and (Vencord only) `overlay/`, `hotkeys/`, `input/` — real type-checked, source-level reuse, not a build-time bundle dependency. Each `tsconfig.json`'s `include` list is the actual coupling contract: it deliberately omits extension-API-coupled files (e.g. `storage/settings.ts`, which depends on `browser.storage`), pulling in `storage/settings-core.ts` instead so Vencord/OpenCode can typecheck and build without a WebExtension host.