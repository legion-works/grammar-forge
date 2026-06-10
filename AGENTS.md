# AGENTS.md — GrammarForge

Self-hosted, privacy-first grammar/writing assistant. A drop-in replacement for
LanguageTool Premium that adds custom Vencord + OpenCode integrations and learns
the user's style over time. The LLM slow path is **bring-your-own** (any
OpenAI-compatible endpoint). Full design lives in **`.opencode/specs/SPEC.md`** —
authoritative, but **still v0.1 draft**; confirm details before treating them as fixed.

> **This repo is destined to be PUBLIC / open-source.** Treat every commit as world-readable.
> See "Public repo hygiene" below — it is non-negotiable.

## Current state

- **Phases 1–2 + browser client shipped; Vencord client built.** The Go bridge
  (`bridge/`: fast path, LLM escalation, sentence cache, REST + native `/v2/check` +
  gRPC, SQLite edit-level signal log) and the WXT browser extension (`clients/browser/`)
  are implemented, tested, and deployed for live testing. The Vencord client
  (`clients/vencord/`) is live-tested and working in Vesktop (underlines, popover
  apply + dictionary, ctrl+. hotkey, paste-skip, signals, chat-bar button with
  hover pill + corrections panel, apply-all/undo/rephrase/pause; text edits go
  through the Slate-safe `slate-apply.ts` — never mutate the DOM selection).
  OpenCode client and Phase-3 learning loop not started. Polyglot repo — each service
  brings its own toolchain (below).

## Where things live

- **Design docs live under `.opencode/`** — spec in `.opencode/specs/`, plans in
  `.opencode/plans/`. Put new specs/plans/design notes there, not at the repo root.
- `.opencode/node_modules` + `package*.json` are OpenCode's own plugin SDK (gitignored) —
  **not** project code; ignore them when working on GrammarForge.
- `AGENTS.md` (this file) and per-service code/config stay at the repo root / service dirs.

## Architecture in one breath

Clients → **Bridge (Go, the core)**. The bridge runs the **fast path IN-PROCESS** —
Harper (Rust, ~10ms, CGo) → GECToR (ONNX via `hugot`) — and escalates to the
**slow-path LLM** (default **llama.cpp**, OpenAI-compatible), with a **per-sentence
LRU cache** so unchanged sentences never re-hit the pipeline. A separate offline
**Python learning loop** fine-tunes a LoRA adapter from logged corrections (Phase 3,
not started).

> **No model sidecar, no LanguageTool container.** GECToR + Harper run inside the
> bridge. The bridge serves the LT wire protocol itself (`internal/ltcompat`); a real
> LanguageTool container is an OPTIONAL compose profile for users who also want LT's
> native Java rules (fed via the bridge's gRPC RemoteRule). The only other runtime
> service is the LLM backend.

The **Bridge runs two listeners**, which is easy to miss:
- a **REST server** (`/correct`, `/rephrase`, `/signal`, `/health`, `/stats`, plus the
  LT-compatible `POST /v2/check` + `GET /v2/languages`) consumed directly by every
  client, and
- a **gRPC server** implementing LanguageTool's `RemoteRule` — used ONLY by the
  optional real-LT profile; vestigial otherwise (kept deliberately).

## Planned layout (from the compose build contexts in SPEC §8)

| Dir | Lang | Purpose |
|---|---|---|
| `bridge/` | Go | gRPC + REST + **GECToR (hugot/ONNX) + Harper (CGo)** + SQLite logger + prompt builder — the whole hot path |
| `config/` | — | `server.properties`, `remote-rules.json`, `bridge.yaml` |
| `models/` | — | GECToR ONNX weights — gitignored, never commit |
| `adapters/` | — | Phase-3 LoRA adapters — gitignored |
| `data/` | — | `corrections.db` (SQLite) — gitignored, holds user text |
| `ngrams/` | — | optional LT n-gram dataset (~16 GB) — gitignored, never commit |
| later | TS/Go | Vencord plugin, browser-extension fork (`textchecker`), OpenCode LSP shim |

> There is **no `gector/` service** — the original Python sidecar was folded into the Go
> bridge via `knights-analytics/hugot`. Don't recreate it.

## Non-obvious constraints — getting these wrong breaks the project

- **Privacy is invariant #1.** The app must never phone home: no telemetry, analytics, or
  cloud calls of *our own* on any correction path. The **only** outbound traffic is to the
  user-configured LLM endpoint, and its default MUST be local (llama.cpp in-compose) so text
  stays on-prem out of the box. Pointing the LLM at a remote endpoint is the user's explicit
  opt-in — never the default, never forced.
- **Bring-your-own LLM.** The slow path speaks the OpenAI-compatible chat-completions API
  (`{base_url}/v1/chat/completions`), configured by `base_url` / `model` / optional `api_key`.
  Do **not** hardwire a backend-specific client or hardcode model/URL — any OpenAI-compatible
  backend (llama.cpp default; vLLM, Ollama, LM Studio, remote) must work via config alone.
  Default model `gemma-4-E4B-it-qat-Q4_K_XL` served by llama.cpp. **Idle behaviour** is
  backend-specific: llama.cpp keeps one small model resident (the `llama-server` router can
  swap models on demand); vLLM exposes `/sleep`+`/wake_up`; Ollama uses `keep_alive`. All
  are expected behaviour, not a bug.
- **Scope is deliberately narrow:** English-only, single-user, self-hosted. Do not add
  i18n, auth, or multi-user / cloud-sync machinery.
- **The bridge is NOT CGo-free.** `hugot` (ONNX) and Harper both need CGo + bundled native
  libs (`libonnxruntime`, Rust `tokenizers`, harper). Still keep SQLite on pure-Go
  `modernc.org/sqlite` (NOT `mattn/go-sqlite3`) — no reason to add a *third* CGo dep for the DB.
- **LanguageTool's `RemoteRule` gRPC interface is undocumented.** Generate Go bindings from
  LT's `MLServerProto.proto` (in LT source; see SPEC §13). Don't invent the protocol.
- **LT↔Bridge wiring is via `remoteRulesFile` (a JSON config file), not a gRPC URL.** Set
  `langtool_remoteRulesFile=/remote-rules.json`; that JSON points at the bridge's gRPC.
- **Hot path is Harper → GECToR → LLM**, all behind a <100ms budget. Harper (~10ms) and
  GECToR (~20–40ms CPU) run on every request, in-process; the LLM (~300–800ms) is
  **escalation-only** (low GECToR confidence / long sentence). Never put the LLM on every keystroke.
- **Interactive clients check typed input only — never pastes.** The Vencord and OpenCode
  plugins must skip pasted text (large single-edit insertions) so pasted code/quotes/links
  aren't flagged or rewritten. Only live typing is checked.
- **The bridge suggests; it never mutates text. Application is client-side.** Default UX is
  overlay + a **configurable accept hotkey** (e.g. `Tab` in Vencord on the highlighted span;
  editor quick-fix keybind in OpenCode) — nothing auto-applies. **Autocorrect (auto-apply)
  is an opt-in client config, off by default** (e.g. a browser-extension setting). Keep
  hotkeys/autocorrect/overlay in the client; the bridge stays UI-agnostic.
- **External API contracts — don't reshape casually:** `/v2/check` must stay
  LanguageTool-compatible (drop-in for existing clients) — it is served NATIVELY by the
  bridge (`internal/ltcompat`): offsets are **UTF-16 code units** (Java String semantics,
  converted from the bridge's byte spans — the load-bearing detail), zero-length
  insertions are widened onto an adjacent rune, and `software.premium` + per-rule
  `isPremium` DO surface (the old OSS-LT serializer limitation no longer applies).
  `/correct` is GrammarLLM-compatible JSON. The bridge's gRPC `Rule.isPremium` is ignored
  by OSS `GRPCRule` (kept for premium LT builds). For bridge-native clients the premium
  source of truth remains REST `GET /health`. The upstream LT browser add-on is
  closed-source/outdated and cannot be patched (fork `codextde/textchecker` for the
  custom UI instead).
- **Phase order matters.** Phase-1 personalisation is a prompt-level accept/reject cache,
  **not training**. We log `base_model`/`adapter` now to *architect* for the Phase-3 QLoRA
  loop, but don't build it before ~500 accepted corrections.
- **LLM over-edit repair chain (`internal/correction/overedit.go`).** The bridge
  deterministically reverts measured LLM over-edit classes (nor/or
  proximity-agreement flips, proper-noun comma restructures) on the LLM output
  TEXT before diffing — text-level on purpose: the diff fuses wanted+unwanted
  edits into single suggestions, so suggestion-level filtering is lossy.
  `GF_OVEREDIT_FILTER` (default true). New rules: add to
  `DefaultOverEditRules`, gate on the FULL cold golden eval.

## Ports (host→container differ — don't guess)

| Service | Host | Container | Endpoint |
|---|---|---|---|
| Bridge REST | 8000 | 8000 | `/correct`, `/correct/stream` (SSE), `/rephrase`, `/signal`, `/health`, `/stats`, **`/v2/check` + `/v2/languages` (LT-compatible, served natively)** |
| Bridge gRPC | 8082 | 8082 | RemoteRule (only consumed by the OPTIONAL real-LT profile) |
| LanguageTool (optional profile) | 8081 | 8010 | real LT's `/v2/check` (union of LT rules + bridge matches) |
| LLM backend | — | 8000 (llama.cpp / vLLM) / 11434 (Ollama) | internal only — clients hit the bridge, not the LLM |

> On the live your-server deploy, host `:8081` is bound to the BRIDGE's REST port so
> LT-protocol clients configured for the old LanguageTool URL keep working.

GECToR + Harper have **no port** — they run inside the bridge process.

## Models (exact IDs — agents tend to guess these wrong)

- LLM slow path (default): `gemma-4-E4B-it-qat-Q4_K_XL` — **Gemma 4 E4B QAT GGUF**, served
  by **llama.cpp** (`llama-server`, OpenAI-compatible, image `ghcr.io/ggml-org/llama.cpp:server-cuda`).
  Spike-measured (text-only): **ERRANT F0.5 0.906, 89.7% exact, 0 clean-FP at ~3.29 GiB
  resident** — best quality + lowest VRAM of every backend tested; beats the old
  GRMR-V3-vLLM-FP8 default on both axes. On-disk filename is
  `gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf` (note the `UD-` infix in the filename; the
  `--alias` and `GF_LLM_MODEL` drop it). Source repo: `unsloth/gemma-4-E4B-it-qat-GGUF`.
  Place at `models/llm/` (gitignored via `*.gguf`). A 2026-06-10 4B-class bake-off
  confirmed the champion (Qwen3.5-4B 102/125, Qwen3-4B-Instruct-2507 97/125 vs 125/125
  golden; no GEC-specialised 4B fine-tune exists) — don't re-run without a bigger VRAM
  budget. See `.opencode/specs/2026-06-10-llm-bakeoff-4b-spike.md`.
- **GRMR-V3 + vLLM (documented BYO alternate):** `qingy2024/GRMR-V3-Q4B` (Qwen3-4B BF16, "Q4"
  = the 4B size class, NOT 4-bit), served by **vLLM at FP8**
  (`--quantization fp8 --kv-cache-dtype fp8`): spike-measured 4.19 GiB weights, quality
  byte-identical to BF16, ~230 ms p50. **Only bring vLLM back when you need per-request
  LoRA hot-swap** (`VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` + `POST /v1/load_lora_adapter`,
  atomic `load_inplace`) — required to architect for Phase-3 personalisation. INT4 remains
  a memory-constrained-only fallback (spike found semantic flips + hallucinations on the
  4B model). CPU fallback `GRMR-V3-Q1.7B`; generic BYO `Qwen3-4B/1.7B`.
- **GRMR-V3 takes NO system prompt** — use its native completion format
  (`<|text_start|>…<|corrected_start|>`, `/v1/completions`). The bridge prompt builder must
  **branch on model family** (GRMR-native vs generic-instruct chat+system). The new default
  (Gemma QAT chat template) needs `chat_template_kwargs:{enable_thinking:false}` for any
  reasoning-capable chat model (the bridge sends it) or the model emits chain-of-thought
  and returns empty content. See SPEC §5.4.
- GECToR fast path: `gotutiyan/gector-deberta-large-5k` — **ship INT8** (~28 ms CPU, 397 MB;
  FP32 ~95 ms misses budget) via `hugot`. Needs a **custom ONNX export** (not `optimum-cli`;
  DeBERTa-v1, custom heads) + bundled `verb-form-vocab.txt` + 2–3 decode passes. Build `-tags ORT`.
- Harper pre-filter: `harper-core` via `hippietrail/harper-c` CGo (`libharper_c.so` ~16 MB,
  ~4 ms warm; cache one `LintGroup` per process).
- **LLM idle behaviour (backend-specific):** the default llama.cpp keeps one ~3.3 GiB model
  resident (no idle timer needed); optional model-swap uses llama-server's router
  (`--models-preset` / `--models-max`). If you bring vLLM back as a BYO, its `/sleep`
  (level 2) + `/wake_up` mode frees ~88% VRAM (requires `--enable-sleep-mode`) — the
  bridge does not own an idle timer. Ollama uses `keep_alive` auto-unload.

## Toolchain (greenfield — use these when scaffolding)

Low-config, modern, consolidated tools. Per-service toolchains live in each service dir; one
root `Taskfile.yml` fans out via `includes:`.

| Area | Tools | Gotchas |
|---|---|---|
| Go (`bridge/`) | `golangci-lint` v2 (gofumpt+goimports) · `go test -race -cover` + `testify` · `govulncheck` | golangci-lint reads CGo without `CGO_ENABLED`; put `#cgo CFLAGS/LDFLAGS` in source, not env; bundle native libs in `bridge/native/` |
| TypeScript (Vencord, `textchecker`) | **`oxlint` + `oxfmt`** (Oxc, Rust) · `tsc --noEmit` (strict) · **Vitest** (`WxtVitest` plugin) | run `wxt prepare` before `tsc` so `#imports` resolves |
| Python (learning loop) | `uv` (env/deps) · `ruff` (lint+format) · `ty` or `mypy --strict` · `pytest` | run `ruff format` **before** `ruff check` (avoids fix/format loop) |
| Protobuf | `buf` v2: `lint` + `breaking --against` + `generate` | source of the Go gRPC bindings; don't hand-edit generated code |
| Docker/YAML/CI | `hadolint` · `yamllint` · `dclint` · `actionlint` | actionlint catches GH Actions script-injection |
| Shell | `shellcheck` | already invoked by hadolint + actionlint |
| Git hooks | `lefthook` (Go binary) | fast subset; invokes tools directly (no hook catalog) |
| Secrets (public!) | `gitleaks` (pre-commit + PR gate) + TruffleHog `--only-verified` (weekly) + GitHub push protection | |
| Deps/vuln | `osv-scanner` (PR diff + weekly) + `govulncheck` | |
| Commits/release | Conventional Commits + `release-please` | auto changelog/version |
| Style | `.editorconfig` (tabs for Go; 2-sp YAML/JSON; 4-sp Python/TS) | |

- **lefthook (fast, local):** gitleaks + golangci-lint + yamllint + hadolint + buf lint +
  ruff-format→ruff-check + oxlint; commitlint on `commit-msg`.
- **CI-only (slow):** `tsc --noEmit`, vitest, `go test`, govulncheck, `buf breaking`,
  osv-scanner, trufflehog. Shape: `dorny/paths-filter` → per-service matrix → synthetic
  `ci-complete` required check; gitleaks always runs (even docs-only PRs).

## Code conventions (greppable + separation of concerns — hard requirement)

- **Greppable names.** Descriptive, full-word, unique identifiers — no cryptic abbreviations
  (`handleCorrectRequest`, not `hndlReq`). File name = its primary concern. **One concept →
  one name, repo-wide**, across Go/TS/Python (shared vocab: correction, suggestion, signal,
  span, edit, fast-path, slow-path) so a single multi-pattern grep (snake/camel/Pascal) finds
  every site. **Never build identifiers dynamically** (no string-concatenated function/route
  names, no reflection dispatch hiding call sites) — it defeats grep; register explicitly.
- **Separation of concerns.** Transport (gRPC RemoteRule, REST) and model backends
  (Harper/GECToR/LLM) are **thin adapters behind interfaces** defined in a transport-agnostic
  `correction` core; `main` wires them; handlers do no business logic; domain types never
  import a transport/DB package. See the bridge package layout in **SPEC §5.2**. Apply the
  same layering to clients: TS = overlay/UI ≠ API client ≠ paste/hotkey logic; Python loop =
  export ≠ train ≠ eval ≠ deploy.

## Public repo hygiene (this repo is going open-source)

Assume everything committed is permanently world-readable. **Never** put into the repo or git
history:
- secrets / credentials: `api_key`, tokens, passwords, `.env` (use `.env.example` with
  placeholders only).
- user text or the correction DB: `data/`, `*.db`, `*.jsonl` exports — all gitignored, keep
  it that way.
- the maintainer's personal/infra details: real hostnames, IPs, LAN addresses, usernames,
  absolute home paths, server URLs. Use placeholders (`http://your-server:8081`,
  `http://ollama:11434/v1`) in all docs, configs, and examples.
- large/derived assets: model weights, `ngrams/`, ONNX/gguf/safetensors.

Before any commit: re-check the diff for the above, and never `git add -A` blindly. If
personal info ever lands in a commit, stop and tell the maintainer (history rewrite needed
before the repo goes public). Currently there are **no commits** — keep the slate clean.

## Open decisions (SPEC §12 — not settled)

Hot-path latency on target hardware (measure) · Gemma QAT quality vs GECToR (local eval) ·
single GECToR vs 3-model ensemble · CPU slow-path quality (GPU recommended?) · Vencord
composer/paste hook reliability · LoRA retrain trigger (time- vs data-based).
