# GrammarForge — Project Specification

**Version:** 0.1
**Date:** 2026-06-07
**Status:** Draft

---

## 1. Overview

GrammarForge is a self-hosted, privacy-first grammar and writing assistant platform that replaces cloud services like Grammarly and LanguageTool Premium. It surfaces corrections through all existing LanguageTool-compatible clients (browser extensions, Obsidian, LibreOffice, VS Code, etc.) while adding custom integrations for Vencord and OpenCode. Over time it adapts to the user's personal writing style through a local learning loop.

---

## 2. Goals

- 100% self-hosted by default — with the default config, no text leaves the server
- **Bring-your-own LLM:** the slow path talks to any OpenAI-compatible chat-completions
  endpoint (local *or* remote), selected via config. Ships with a local default.
- Drop-in replacement for LanguageTool Premium (same `/v2/check` API)
- Fast enough for real-time typing feedback (<100ms on the hot path)
- Supports custom plugin integrations: browser extension, Vencord, OpenCode
- Learns from accepted/rejected corrections to personalise over time
- Unlocks LanguageTool "premium" features (contextual ML, rephrasing, picky mode) locally
- Open-source / public repo: no personal data, secrets, or user text ever in git

---

## 3. Non-Goals

- Multi-language support (English-only, at least initially)
- Cloud sync or multi-user support
- Mobile apps

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Clients                                                │
│  Browser ext (LT) │ Vencord plugin │ OpenCode LSP       │
└──────────┬────────────────┬─────────────────┬──────────┘
           │ /v2/check      │ /v2/check or     │ LSP
           │ (HTTP)         │ /correct (HTTP)  │ diagnostics
┌──────────▼────────────────▼─────────────────▼──────────┐
│  LanguageTool Server (Java, port 8081)                  │
│  • 2,500+ deterministic rules                           │
│  • n-gram confusables dataset (optional, ~16GB)         │
│  • Personal dictionary                                  │
│  • remoteRulesFile → gRPC to bridge                     │
└──────────────────────┬──────────────────────────────────┘
                       │ gRPC (remoteRulesFile)
┌──────────────────────▼──────────────────────────────────┐
│  GrammarForge Bridge (Go) — single process               │
│  • gRPC server (LanguageTool RemoteRule protocol)        │
│  • REST server (/correct, /rephrase, /signal, /health,   │
│    /stats)                                                │
│  • FAST PATH runs IN-PROCESS (no sidecar):               │
│      Harper (Rust, ~10ms, via CGo)                        │
│        → GECToR ONNX (Go, via hugot / ONNX Runtime)       │
│  • Tiered routing: fast path → LLM escalation            │
│  • Correction event logger (SQLite, pure-Go)             │
│  • Dynamic system prompt builder (personalisation)       │
│  • Quality scorer (0-100, GrammarLLM-style)              │
└──────────────────────┬───────────────────────────────────┘
                       │ slow path (~300–800ms), OpenAI-compatible /v1
┌──────────────────────▼──────────────────────────────────┐
│  LLM Backend (OpenAI-compatible) — default: vLLM         │
│  Model: GRMR-V3-Q4B (Qwen3-4B base)                      │
│  CPU fallback: GRMR-V3-Q1.7B                             │
│  + personal LoRA adapter (runtime hot-swap)             │
│  Idle offload when dormant (vLLM sleep / keep_alive)     │
│  BYO alternates: Ollama · llama.cpp · LM Studio · remote │
└──────────────────────┬───────────────────────────────────┘
                       │ accepted corrections (JSONL export)
┌──────────────────────▼──────────────────────────────────┐
│  Personal Learning Loop (Python, offline)                │
│  SQLite → JSONL → QLoRA (Unsloth) → PEFT adapter         │
│  → vLLM load_lora_adapter (atomic) → eval → rollback     │
└───────────────────────────────────────────────────────────┘
```

---

## 5. Components

### 5.1 LanguageTool Server

- **Source:** `meyayl/docker-languagetool` (Docker image)
- **Config:** `server.properties` with `remoteRulesFile` pointing to bridge gRPC
- **Exposes:** `/v2/check` HTTP endpoint (standard LT API)
- **Optional:** n-gram dataset for better confusable detection (15–16 GB, recommended)

### 5.2 GrammarForge Bridge (Go)

The core of the project. Replaces Grammared-Language's Python gRPC bridge with a more performant Go implementation.

**Responsibilities:**
- Implement LanguageTool's `RemoteRule` gRPC interface
- Route requests through the correction pipeline (GECToR → LLM if needed)
- Log every correction suggestion + user signal (accept/reject/ignore) to SQLite
- Build and cache dynamic system prompts for the LLM based on user history
- Expose additional REST endpoints (`/correct`, `/rephrase`, `/health`, `/stats`)
- Return quality scores (0-100) alongside corrections

**Tiered routing logic:**
1. **Harper** (in-process, ~10ms) runs first — cheap orthographic/spelling/capitalisation
   catches that should never burn GECToR cycles
2. **GECToR** (in-process ONNX, ~20–40ms CPU) next — structural errors (agreement,
   articles, tense, plurals)
3. If GECToR confidence < threshold OR sentence is long/complex → escalate to the **LLM**
4. Merge results, deduplicate, rank by confidence
5. Return via gRPC to LanguageTool (or as REST JSON to direct clients)

> Both Harper and GECToR run **inside the bridge process** — there is no Python/Triton
> model sidecar. See §5.3.

**Dependencies:**
- `google.golang.org/grpc`
- `modernc.org/sqlite` (pure-Go SQLite — keeps the DB free of CGo; the ML libs below are
  the only CGo we accept)
- `github.com/knights-analytics/hugot` — Go ONNX Runtime pipeline (runs GECToR; CGo +
  bundled `libonnxruntime` and static Rust `tokenizers`)
- Harper via CGo (`hippietrail/harper-c` FFI over `harper-core`) — the ~10ms pre-filter
- An OpenAI-compatible client (e.g. `github.com/sashabaranov/go-openai`, or plain
  `net/http` against `/v1/chat/completions`) — **not** an Ollama-specific client, so any
  OpenAI-compatible backend works
- LanguageTool gRPC bindings generated from LT's `MLServerProto.proto` (see §5.1 / §11)

> **Build reality:** the bridge is one Go binary, but it is **not CGo-free** — the image
> bundles `libonnxruntime`, the Rust `tokenizers` lib, and the Harper lib. This is still a
> single service / single container, a major simplification over a multi-language stack.

**Package layout (separation of concerns).** The core correction logic must not know about
gRPC, REST, ONNX, or HTTP. Transport and model backends are thin adapters behind interfaces
defined in the core, wired together only in `main`:

```
bridge/
  cmd/grammarforge/      # main(): config load + dependency wiring ONLY (no logic)
  internal/
    correction/          # CORE domain: types (Span, Suggestion, Correction) + the
                         #   Harper→GECToR→LLM pipeline/router. Depends on interfaces only:
                         #   Corrector, LLMClient, Store, PromptBuilder.
    harper/              # Harper CGo pre-filter            — implements Corrector
    gector/              # GECToR ONNX via hugot            — implements Corrector
    llm/                 # OpenAI-compatible HTTP client    — implements LLMClient
    prompt/              # dynamic system-prompt + accept/reject cache — PromptBuilder
    store/               # SQLite (modernc) logger + JSONL export       — implements Store
    grpcserver/          # LT RemoteRule adapter: maps MLServerProto <-> correction (thin)
    restserver/          # REST adapter: /correct /rephrase /signal /health /stats (thin)
    config/              # bridge.yaml / env loading
  proto/                 # generated gRPC bindings (buf)
  native/                # bundled libonnxruntime / tokenizers / harper libs
```

Rules: transport handlers do **no** business logic (translate → call `correction` → translate
back); model backends and the store are swapped via the core's interfaces (this is what makes
BYO-LLM and the in-process model design testable); domain types live in `correction` and never
import a transport/DB package.

**Naming for searchability (greppability is a requirement).** Every function, type, and
module must be findable with a single grep:
- Use **descriptive, full-word, unique** identifiers — no cryptic abbreviations
  (`handleCorrectRequest`, not `hndlReq`). File name = its primary concern (`gector.go`,
  `llm_client.go`).
- **One concept, one name, repo-wide.** Keep a shared vocabulary (correction, suggestion,
  signal, span, edit, fast-path, slow-path). Don't call the same thing `suggestion` in Go and
  `fix` in TypeScript — pick one word per concept across all languages so a single
  multi-pattern grep (snake/camel/Pascal of the same word) finds every site.
- **Never construct identifiers dynamically** (no string-built function/route names, no
  reflection dispatch that hides call sites) — it defeats grep. Register routes/handlers
  explicitly.

### 5.3 Fast Path — Harper + GECToR (in-process, no sidecar)

Two stages, both embedded in the Go bridge:

**Harper (orthographic pre-filter)**
- **What:** `harper-core` (Rust, rule + dictionary based), embedded via the
  `hippietrail/harper-c` C FFI.
- **Latency:** ~10ms, CPU-only, no model weights.
- **Role:** spelling, capitalisation, repeated words, a/an, simple punctuation — the cheap,
  high-confidence checks. Harper alone misses deeper grammar, so it only *pre-filters*.
- **Also reused** as the OpenCode in-editor layer via `harper-ls` (see §5.6).

**GECToR (structural GEC)**
- **Model:** `gotutiyan/gector-deberta-large-5k` (DeBERTa-Large, ~0.4B). Still SOTA-class
  for single-model English GEC in 2026; LLM scaling plateaus at the same ~68% F0.5 ceiling
  (Grammarly "Pillars of GEC", 2024). `Meyssa/gector-large-2024` (INT8 ONNX) is a smaller
  memory-constrained fallback.
- **Runtime:** ONNX Runtime **in Go** via `knights-analytics/hugot` (ORT = fastest CPU
  backend). Export the HF model to ONNX with Optimum. **No Triton, no FastAPI sidecar** —
  Triton is overkill for a single 0.4B CPU model at one-user load.
- **Latency:** ~20–40ms/sentence on CPU, ~3ms on GPU.
- **Role:** structural errors (agreement, articles, tense, plurals). Needs a thin Go
  post-processor for GECToR edit ops ($KEEP/$DELETE/$REPLACE_x/$APPEND_x), confidence
  thresholding, and iterative passes.

### 5.4 LLM Backend (Slow Path)

- **Interface:** OpenAI-compatible chat-completions API (`POST {base_url}/v1/chat/completions`).
  Works with **any** OpenAI-compatible server — vLLM, Ollama, llama.cpp `server`, LM Studio,
  LiteLLM, OpenRouter, OpenAI itself, etc. Users **bring their own**.
- **Default backend: vLLM.** It is the only backend with a real runtime LoRA hot-swap
  (`VLLM_ALLOW_RUNTIME_LORA_UPDATING=True` + `POST /v1/load_lora_adapter`, `load_inplace`
  atomic) — required to architect for Phase-3 personalisation. CPU hosts use the `vllm-cpu`
  wheel. **BYO alternates (documented):** Ollama (simplest; cannot per-request hot-swap as
  of mid-2026), llama.cpp `server` (lowest resource; adapter swap only when idle), LM Studio
  (desktop), LiteLLM (proxy, not an engine).
- **Idle offload:** when dormant, the model should be offloaded to free VRAM/RAM (vLLM sleep
  mode; Ollama `keep_alive` auto-unload) and reloaded on demand.
- **Config (per deploy, in `bridge.yaml` / env — never committed):**
  - `llm.base_url` — default `http://vllm:8000/v1` (in-compose); or `http://ollama:11434/v1`,
    or any remote endpoint
  - `llm.model` — default `qingy2024/GRMR-V3-Q4B`
  - `llm.api_key` — optional; required by some backends. **Secret — never commit.**
- **Default model:** `qingy2024/GRMR-V3-Q4B` (Qwen3-4B base, full fine-tune, grammar-specific).
  Needs a GPU to hit the 300–800ms budget for 50–100-token outputs.
- **CPU fallback:** `qingy2024/GRMR-V3-Q1.7B` (smaller, CPU-feasible at some quality cost).
  Generic BYO fallback: `Qwen3-4B` / `Qwen3-1.7B` + a grammar-fix system prompt.
- **Role:** Contextual corrections (homophones, complex misspellings, style, rephrasing).
- **Personalisation:** per-user LoRA adapter, hot-swapped at runtime (vLLM). See §5.5.
- **Privacy note:** the default `base_url` MUST point at a local backend so the
  out-of-the-box experience keeps text on-prem. Pointing it at a remote endpoint is an
  explicit, opt-in user choice — never the default, and the app never forces it.

**System prompt (base):**
```
You are a grammar and style corrector. Fix only genuine errors in the user's text.
Do not rewrite sentences. Do not change the user's intended meaning or voice.
Return ONLY the corrected text with no explanation.
```

Dynamic additions are injected per-user from the personalisation layer.

### 5.5 Personal Learning Loop (Python, offline)

Runs as a cron job (e.g., weekly or on reaching 500 new samples).

**Pipeline:**
1. Read correction log from SQLite (accepted corrections only) — exposed via a bridge
   `export` command that dumps JSONL
2. Export as JSONL: `{"input": "<original>", "output": "<corrected>"}`
3. Run QLoRA fine-tune on the base grammar model with **Unsloth** (2–5× faster, ~70% less
   VRAM; 4B QLoRA fits ~8 GB). PEFT / LLaMA-Factory are interchangeable alternatives.
4. Export the PEFT-format adapter
5. **Hot-swap into vLLM** at runtime: `POST /v1/load_lora_adapter` (atomic `load_inplace`,
   no restart). For llama.cpp, convert to GGUF first; for Ollama, bake via Modelfile `ADAPTER`.
6. Run evaluation on a held-out JFLEG sample to confirm quality didn't regress
7. Roll back (re-load the previous adapter) if eval score drops

**Short-term alternative (Phase 1, no training required):**
- Maintain a rejection cache: patterns the user has rejected 3+ times
- Inject as negative examples into the LLM system prompt
- Maintain an acceptance cache: inject as few-shot positive examples
- This gives ~80% of personalisation benefit with zero compute

### 5.6 Client Integrations

#### Correction application model (all interactive clients)

The **bridge only suggests — it never mutates the user's text.** How a suggestion gets
applied is entirely a **client-side** concern, configured per client:

- **Default = suggest, don't auto-apply.** The client renders an overlay (underline /
  highlight) on each flagged span.
- **Apply via a configurable hotkey.** When a flagged span is focused/highlighted, a
  user-configurable key (default e.g. `Tab`) applies the active suggestion; dismiss/skip
  (e.g. `Esc`) leaves the text untouched. Each accept/dismiss emits an
  `accepted` / `rejected` / `ignored` signal to the bridge `POST /signal` (feeds the
  learning loop).
- **Autocorrect (auto-apply with no keypress) is opt-in, off by default**, and is a
  **client-side config toggle** (e.g. a setting in the browser extension). The bridge stays
  UI-agnostic and stateless about application; the hotkey, autocorrect toggle, and overlay
  styling all live in the client.

#### Browser Extension
- **LanguageTool-compatible extensions work out-of-the-box for `/v2/check`** — just point
  them at `http://your-server:8081`.
- **The upstream LT browser add-on cannot be patched.** Its repo is marked *OUTDATED* and
  the shipped store extension is closed-source — the old "fork it and hardcode `premium:
  true`" plan is **not viable**. The bridge can still inject `premium: true` into `/v2/check`
  responses for any client that gates on it.
- **For the rephrase / LLM UI, fork `codextde/textchecker` (MIT, TS/React/WXT).** Its
  BYO-LLM design matches our slow path; point its endpoint at the bridge's `/correct` and
  `/rephrase`, default to the local LLM URL.
- **Application:** per the model above — overlay + configurable accept hotkey, with an
  **autocorrect toggle as an extension setting** (off by default).

#### Vencord Plugin (TypeScript)
- Custom Vencord plugin that intercepts the Discord message composer
- Debounces input (500ms idle before checking)
- **Checks typed input only — never pasted text.** Detect and skip paste events so pasted
  snippets, quotes, links, and code aren't flagged or rewritten.
- POSTs to the bridge's `/correct` endpoint (GrammarLLM-compatible JSON)
- Renders inline underlines (overlay) using Vencord's patcher API
- **Apply via a configurable hotkey** (default `Tab`) on the highlighted span; nothing is
  auto-applied unless the user turns on autocorrect in plugin settings
- Accept/reject signals logged back to the bridge (for learning loop)
- No dependency on the LT gRPC path — talks directly to the REST API

#### OpenCode
- **Phase 1:** point OpenCode's LSP at `harper-ls` (Apache-2.0, actively released) for an
  instant baseline — same Harper engine the bridge embeds.
- **Phase 1.5:** build a minimal Go LSP shim that wraps the bridge's `/correct` endpoint,
  translates to LSP Diagnostics, and logs accept/reject signals into the same
  personalisation cache. This gives OpenCode the full GECToR + LLM corrections, not just
  Harper's rule-based subset.
- **Checks typed input only — never pasted text** (same rule as the Vencord plugin). On
  `didChange`, skip large single-edit insertions (the paste signature) and only check the
  incrementally typed range; pasted blocks must not be auto-flagged or rewritten.
- **Apply via the editor's accept/quick-fix keybind** (surfaced as an LSP code action), not
  auto-applied — same suggest-then-confirm model; the keybind is the editor's, configurable.

---

## 6. "Premium" Feature Parity

| LT Premium Feature       | GrammarForge Implementation                                    |
|--------------------------|----------------------------------------------------------------|
| Contextual spelling      | Harper + GECToR + LLM                                          |
| Homophone detection      | LLM slow path (GRMR-V3)                                        |
| Picky mode               | LLM returns style-class suggestions; tagged as custom category |
| Rephrasing               | `/rephrase` endpoint on bridge, calls LLM                      |
| Tone detection           | LLM with tone classification prompt, returned as rule matches  |
| Personal dictionary      | LT native + Harper user dictionary                            |
| Premium UI in extension  | Bridge injects `premium: true` into `/v2/check`; custom UI via textchecker fork |

---

## 7. Data Model

### Correction Log (SQLite)

```sql
CREATE TABLE corrections (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,          -- unix ms
    source      TEXT NOT NULL,             -- 'vencord' | 'browser' | 'opencode'
    original    TEXT NOT NULL,             -- original sentence
    suggestion  TEXT NOT NULL,             -- suggested correction
    model       TEXT NOT NULL,             -- 'harper' | 'gector' | 'llm' | 'lt_rule'
    rule_id     TEXT,                      -- LT rule id if applicable
    signal      TEXT,                      -- 'accepted' | 'rejected' | 'ignored'
    signal_ts   INTEGER,                   -- when the signal was received
    context     TEXT,                      -- surrounding text (window of 2 sentences)
    base_model  TEXT,                      -- LLM model id that produced 'llm' suggestions
    adapter     TEXT                       -- active LoRA adapter id, if any (Phase-3)
);

CREATE INDEX idx_signal ON corrections(signal);
CREATE INDEX idx_ts     ON corrections(ts);
```

> `base_model` / `adapter` are populated now (even before Phase-3) so the JSONL export can
> attribute training pairs to the model that generated them.

---

## 8. Docker Compose Layout

```yaml
services:
  languagetool:
    image: meyayl/languagetool:latest
    ports: ["8081:8010"]
    volumes:
      - ./config/server.properties:/server.properties
      - ./config/remote-rules.json:/remote-rules.json
      - ./ngrams:/ngrams   # optional, large
    environment:
      langtool_remoteRulesFile: /remote-rules.json

  # Core service. Embeds Harper (CGo) + GECToR (ONNX via hugot) IN-PROCESS — no sidecar.
  bridge:
    image: grammarforge-bridge:latest  # built locally
    build: ./bridge
    ports:
      - "8082:8082"   # gRPC (for LanguageTool)
      - "8000:8000"   # REST (/correct, /rephrase, /signal, /health, /stats)
    volumes:
      - ./data:/data                # corrections.db (SQLite) — gitignored
      - ./config/bridge.yaml:/config.yaml
      - ./models:/models            # GECToR ONNX weights — gitignored
    environment:
      GF_LLM_BASE_URL: http://vllm:8000/v1   # override for BYO
      GF_LLM_MODEL: qingy2024/GRMR-V3-Q4B
    depends_on: [vllm, languagetool]

  # Default LLM backend (OpenAI-compatible). Best quality + runtime LoRA hot-swap; GPU
  # recommended. Swap by pointing bridge GF_LLM_BASE_URL at any OpenAI-compatible server.
  vllm:
    image: vllm/vllm-openai:latest    # use a vllm-cpu image on CPU-only hosts
    command: ["--model", "qingy2024/GRMR-V3-Q4B", "--enable-lora"]
    environment:
      VLLM_ALLOW_RUNTIME_LORA_UPDATING: "True"   # Phase-3 hot-swap
    volumes:
      - hf_cache:/root/.cache/huggingface
      - ./adapters:/adapters         # Phase-3 LoRA adapters — gitignored
    # internal only — clients hit the bridge, not vLLM directly
    deploy:
      resources:
        reservations:
          devices: [{ capabilities: [gpu] }]   # remove for CPU-only

  # --- BYO alternate (simplest local backend; no per-request hot-swap) ---
  # ollama:
  #   image: ollama/ollama:latest
  #   ports: ["11434:11434"]
  #   volumes: [ollama_models:/root/.ollama]
  #   # then set bridge GF_LLM_BASE_URL=http://ollama:11434/v1

volumes:
  hf_cache:
  # ollama_models:
```

---

## 9. Technology Stack

| Layer                   | Language   | Key Libraries / Tools                          |
|-------------------------|------------|------------------------------------------------|
| gRPC bridge + REST API  | Go         | `google.golang.org/grpc` (gen from `MLServerProto.proto`) |
| Correction logger       | Go         | `modernc.org/sqlite` (pure-Go)                 |
| GECToR (fast path)      | Go         | `knights-analytics/hugot` (ONNX Runtime, CGo)  |
| Harper (pre-filter)     | Go/Rust    | `harper-core` via `hippietrail/harper-c` (CGo) |
| LLM serving             | any        | OpenAI-compatible API — **vLLM default**; Ollama/llama.cpp/LM Studio/remote |
| LoRA training pipeline  | Python     | **Unsloth** (or LLaMA-Factory / PEFT), QLoRA   |
| Browser extension       | TypeScript | Fork of `codextde/textchecker` (BYO-LLM)       |
| Vencord plugin          | TypeScript | Vencord plugin API                             |
| OpenCode LSP            | Go/Rust    | `harper-ls` baseline; custom Go LSP shim       |
| Orchestration           | YAML       | Docker Compose                                 |

---

## 10. Build Phases

### Phase 1 — Core Stack (target: ~1 weekend)
- [ ] Go bridge: generate gRPC bindings from LT `MLServerProto.proto`, implement RemoteRule
      (use `grammared-language` as architecture reference only — don't fork its Python)
- [ ] Embed GECToR (ONNX via `hugot`) + Harper (CGo) in the bridge — no model sidecar
- [ ] LLM slow path: vLLM + `GRMR-V3-Q4B` (CPU fallback `GRMR-V3-Q1.7B`), OpenAI-compatible client
- [ ] Tiered routing (Harper → GECToR → LLM escalation)
- [ ] Docker Compose for all services
- [ ] Point an LT-compatible client at the local server — verify `/v2/check` works

### Phase 2 — Premium Features + Client Plugins (target: ~2 weeks)
- [ ] `/rephrase` endpoint (LLM-backed)
- [ ] Picky mode / style suggestions (LLM style tags → LT rule format)
- [ ] Browser extension: fork `codextde/textchecker`; bridge injects `premium: true` into `/v2/check`
- [ ] Correction signal API (`POST /signal` from clients)
- [ ] Correction logger (SQLite) — with `base_model` / `adapter` columns for Phase-3
- [ ] Dynamic system prompt builder (rejection/acceptance cache)
- [ ] Vencord plugin (TS): intercept composer, call `/correct`, render underlines, **skip pastes**
- [ ] OpenCode: `harper-ls` baseline, then Go LSP shim — **typed input only, skip pastes**

### Phase 3 — Personal Learning Loop (target: ongoing)
- [ ] Bridge `export` command: correction log → JSONL
- [ ] QLoRA fine-tuning pipeline (Unsloth; run manually or cron)
- [ ] Adapter hot-swap into vLLM (`POST /v1/load_lora_adapter`, atomic)
- [ ] Regression evaluation on JFLEG benchmark
- [ ] Auto-retrain trigger (cron: weekly, or on 500 new accepted samples)

---

## 11. Key Design Decisions

**Why Go for the bridge?**
The bridge is the hot path for every keystroke. Go's gRPC implementation is fast, goroutines handle concurrent model calls cleanly, and it deploys as one service / one container. Python's GIL and asyncio overhead add 2-5ms of unnecessary latency here. Rust would be marginally faster but adds significant development time for this workload. Note: the binary is **not CGo-free** — `hugot` (ONNX) and Harper need CGo and bundled native libs — but it is still a single Go service, a big simplification over a polyglot stack.

**Why run GECToR + Harper in-process (no Python/Triton sidecar)?**
`knights-analytics/hugot` runs the GECToR ONNX model directly in Go (ORT is the fastest CPU backend), and `harper-c` exposes Harper over CGo. For a single 0.4B model at one-user load, Triton's orchestration overhead exceeds its benefit (it wins only at GPU/multi-model/high-concurrency), and a FastAPI sidecar adds a second language and deploy surface for no measurable win. Keeping both in the bridge removes an entire service.

**Why an OpenAI-compatible LLM interface, with vLLM as the default backend?**
Targeting the OpenAI chat-completions schema (not an Ollama-specific client) lets users bring their own backend with only a config change. **vLLM is the bundled default** because it is the only backend with real runtime LoRA hot-swap (`load_lora_adapter`, atomic `load_inplace`) — essential for architecting Phase-3 personalisation now — plus sleep-mode idle offload and a CPU wheel. Ollama stays the documented easy alternate (great BYO, but no per-request hot-swap yet). Triton was rejected for ops overhead; text stays on-prem because the default endpoint is local.

**Why SQLite for the correction log?**
The correction log is append-heavy, single-user, and doesn't need to be queried under load. SQLite is zero-ops, embeds in the Go binary, and is fast enough for this write volume. Valkey/Redis would be overkill.

**Why not fine-tune from day one?**
The dynamic prompt approach (rejection/acceptance cache) provides immediate personalisation with zero compute and zero risk of model degradation. Fine-tuning is reserved for Phase 3 once enough high-quality signal has accumulated (>500 accepted corrections). Starting with fine-tuning before that risks overfitting to noise.

---

## 12. Open Questions

Settled by the 2026-06 research + maintainer decisions (kept here for context):
- ~~Triton vs FastAPI for GECToR~~ → **neither**; run ONNX in-Go via `hugot`, no sidecar.
- ~~GRMR variant~~ → **`GRMR-V3-Q4B`** default, `GRMR-V3-Q1.7B` CPU fallback.
- ~~Patch the LT browser add-on~~ → **not patchable** (closed-source/outdated); fork `textchecker`.
- ~~Ollama vs vLLM default~~ → **vLLM** (hot-swap), Ollama documented BYO.

Still open:
- [ ] **Measure** real hot-path latency on target hardware: Harper (~10ms) + GECToR
      (~20–40ms CPU) under the 100ms budget? Does GPU change the routing thresholds?
- [ ] `GRMR-V3-Q4B` quality vs GECToR/EditScorer on a local JFLEG/BEA eval (V3 has no
      published GEC benchmark — it's a domain fine-tune).
- [ ] 3-model GECToR ensemble (RoBERTa-L + XLNet-L + DeBERTa-L) for +1.5 F0.5 at ~3×
      compute — worth it, or single-model only?
- [ ] CPU fallback viability: is `GRMR-V3-Q1.7B` good enough on CPU, or do we tell CPU-only
      users to expect degraded slow-path quality? README messaging ("GPU recommended").
- [ ] Does Vencord's plugin API expose enough hooks to intercept the composer (and detect
      pastes) reliably across Discord updates?
- [ ] LoRA retrain trigger — time-based (weekly) or data-based (N accepted samples)?

---

## 13. References

- [Grammared-Language](https://github.com/rayliuca/grammared-language) — LT RemoteRule reference architecture (Python; we reimplement in Go)
- [gotutiyan/gector-deberta-large-5k](https://huggingface.co/gotutiyan/gector-deberta-large-5k) — fast-path GEC model
- [Meyssa/gector-large-2024](https://huggingface.co/Meyssa/gector-large-2024) — INT8 ONNX fallback
- [Pillars of GEC (arXiv:2404.14914)](https://arxiv.org/html/2404.14914v1) — the ~68% F0.5 ceiling rationale
- [knights-analytics/hugot](https://github.com/knights-analytics/hugot) — Go ONNX Runtime pipeline (runs GECToR)
- [Automattic/harper](https://github.com/Automattic/harper) + [hippietrail/harper-c](https://github.com/hippietrail/harper-c) — pre-filter + CGo FFI
- [harper-ls](https://writewithharper.com/docs/integrations/language-server) — OpenCode/editor LSP baseline
- [qingy2024/GRMR-V3-Q4B](https://huggingface.co/qingy2024/GRMR-V3-Q4B) — default slow-path LLM (paper: [arXiv:2505.09388](https://arxiv.org/abs/2505.09388))
- [vLLM LoRA docs](https://docs.vllm.ai/en/latest/features/lora/) — runtime adapter hot-swap
- [Unsloth](https://github.com/unslothai/unsloth) — fast QLoRA fine-tuning
- [codextde/textchecker](https://github.com/codextde/textchecker) — BYO-LLM browser-extension fork target
- [LanguageTool MLServerProto](https://languagetool.org/development/api/org/languagetool/rules/ml/MLServerProto.html) — RemoteRule gRPC wire format (generate Go bindings from LT source)
- [GrammarLLM](https://github.com/whiteh4cker-tr/grammar-llm) — GRMR model + REST API design
- [HuggingFace PEFT](https://github.com/huggingface/peft) — LoRA / QLoRA fine-tuning
