# AGENTS.md — GrammarForge

Self-hosted, privacy-first grammar/writing assistant. A drop-in replacement for
LanguageTool Premium that adds custom Vencord + OpenCode integrations and learns
the user's style over time. The LLM slow path is **bring-your-own** (any
OpenAI-compatible endpoint). Full design lives in **`SPEC.md`** — authoritative, but
**still v0.1 draft**; confirm details before treating them as fixed.

> **This repo is destined to be PUBLIC / open-source.** Treat every commit as world-readable.
> See "Public repo hygiene" below — it is non-negotiable.

## Current state

- **Greenfield. No application code, no commits yet.** The only thing present is
  `.opencode/` (OpenCode's own tooling/plugin SDK, with its own `.gitignore` — *not*
  project code; ignore it when working on GrammarForge).
- There is **no build/test/lint system yet**. First work is scaffolding per `SPEC.md`
  Phase 1. This is a polyglot repo — each service brings its own toolchain in its own dir.

## Architecture in one breath

Clients → **LanguageTool (Java)** → gRPC → **Bridge (Go, the core)**. The bridge runs the
**fast path IN-PROCESS** — Harper (Rust, ~10ms, CGo) → GECToR (ONNX via `hugot`) — and
escalates to the **slow-path LLM** (default **vLLM**, OpenAI-compatible). A separate offline
**Python learning loop** fine-tunes a LoRA adapter from logged corrections.

> **No model sidecar.** GECToR + Harper run inside the bridge (changed from the original
> Triton/FastAPI `gector/` service). The only other runtime services are LanguageTool and the
> LLM backend.

The **Bridge runs two listeners**, which is easy to miss:
- a **gRPC server** implementing LanguageTool's `RemoteRule` (consumed by LT), and
- a **REST server** (`/correct`, `/rephrase`, `/signal`, `/health`, `/stats`) consumed
  *directly* by Vencord, OpenCode, and the extension's rephrase button — bypassing LT.

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
  user-configured LLM endpoint, and its default MUST be local (vLLM in-compose) so text stays
  on-prem out of the box. Pointing the LLM at a remote endpoint is the user's explicit
  opt-in — never the default, never forced.
- **Bring-your-own LLM.** The slow path speaks the OpenAI-compatible chat-completions API
  (`{base_url}/v1/chat/completions`), configured by `base_url` / `model` / optional `api_key`.
  Do **not** hardwire a backend-specific client or hardcode model/URL — any OpenAI-compatible
  backend (vLLM default; Ollama, llama.cpp, LM Studio, remote) must work via config alone.
  Default model `qingy2024/GRMR-V3-Q4B`. **Idle offload** when dormant (vLLM sleep /
  Ollama `keep_alive`) is expected behaviour, not a bug.
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
  LanguageTool-compatible (drop-in for existing clients); `/correct` is GrammarLLM-compatible
  JSON. The bridge **injects `premium: true`** into `/v2/check` for clients that gate on it —
  the upstream LT browser add-on is closed-source/outdated and cannot be patched (fork
  `codextde/textchecker` for the custom UI instead).
- **Phase order matters.** Phase-1 personalisation is a prompt-level accept/reject cache,
  **not training**. We picked vLLM + log `base_model`/`adapter` now to *architect* for the
  Phase-3 QLoRA loop, but don't build it before ~500 accepted corrections.

## Ports (host→container differ — don't guess)

| Service | Host | Container | Endpoint |
|---|---|---|---|
| LanguageTool | 8081 | 8010 | `/v2/check` |
| Bridge gRPC | 8082 | 8082 | RemoteRule (consumed by LT) |
| Bridge REST | 8000 | 8000 | `/correct`, `/rephrase`, `/signal`, ... |
| LLM backend | — | 8000 (vLLM) / 11434 (Ollama) | internal only — clients hit the bridge, not the LLM |

GECToR + Harper have **no port** — they run inside the bridge process.

## Models (exact IDs — agents tend to guess these wrong)

- LLM slow path (default): `qingy2024/GRMR-V3-Q4B` (Qwen3-4B base) via **vLLM**; CPU
  fallback `qingy2024/GRMR-V3-Q1.7B`; generic BYO fallback `Qwen3-4B`/`Qwen3-1.7B` + grammar
  prompt. Personalised via LoRA adapter (vLLM hot-swap). The model is **config, not code**.
- GECToR fast path: `gotutiyan/gector-deberta-large-5k` (ONNX via `hugot`); INT8 fallback
  `Meyssa/gector-large-2024`.
- Harper pre-filter: `harper-core` (Rust) via `hippietrail/harper-c` CGo FFI.

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
| Git hooks | `pre-commit` framework | fast subset only |
| Secrets (public!) | `gitleaks` (pre-commit + PR gate) + TruffleHog `--only-verified` (weekly) + GitHub push protection | |
| Deps/vuln | `osv-scanner` (PR diff + weekly) + `govulncheck` | |
| Commits/release | Conventional Commits + `release-please` | auto changelog/version |
| Style | `.editorconfig` (tabs for Go; 2-sp YAML/JSON; 4-sp Python/TS) | |

- **pre-commit (fast, local):** hooks + gitleaks + yamllint + hadolint + buf lint +
  golangci-lint + ruff-format→ruff-check + oxlint; commitlint on `commit-msg`.
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

Hot-path latency on target hardware (measure) · GRMR-V3 quality vs GECToR (local eval) ·
single GECToR vs 3-model ensemble · CPU slow-path quality (GPU recommended?) · Vencord
composer/paste hook reliability · LoRA retrain trigger (time- vs data-based).
