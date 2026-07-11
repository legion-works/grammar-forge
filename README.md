<p align="center">
  <img src="handoff/assets/grammarforge-mark.svg" alt="GrammarForge" width="120">
</p>

<p align="center">
  <strong>Grammar checking that never leaves your hardware. Fast enough to run on every keystroke.</strong>
</p>

<p align="center">
  <a href="https://github.com/legion-works/grammar-forge/actions/workflows/ci.yml?branch=dev"><img src="https://github.com/legion-works/grammar-forge/actions/workflows/ci.yml/badge.svg?branch=dev" alt="CI"></a>
  <img src="https://img.shields.io/badge/go-1.26%2B-00ADD8" alt="Go 1.26+">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License: AGPL-3.0">
  <img src="https://img.shields.io/badge/platform-self--hosted%20%C2%B7%20Docker-informational" alt="Self-hosted">
</p>

---

Cloud grammar checkers read everything you type — that is the product. Your messages, your code reviews, your half-written thoughts, shipped to someone else's servers for scoring.

GrammarForge is a self-hosted replacement. A single Go bridge runs the whole correction pipeline in-process: Harper (~10 ms) for spelling and mechanics, GECToR (~25 ms, ONNX) for structural grammar, and a bring-your-own LLM for the hard cases only. It speaks LanguageTool's wire protocol natively, so existing LT clients work unchanged — and it ships its own clients for the browser, Discord, and the terminal.

## Why it exists

Privacy tools usually trade away quality; grammar tools usually trade away privacy. The design refuses both trades:

- **No text leaves the server, ever.** No telemetry, no analytics, no phone-home. The only outbound traffic is to the LLM endpoint *you* configure — and the default is a local llama.cpp in the same compose stack.
- **The LLM is escalation, not the pipeline.** Every keystroke is checked by the in-process fast path in ~35 ms; the LLM (~300–800 ms) runs only when the fast path isn't confident. A three-tier pipeline, not a chatbot with a spellcheck prompt.
- **Bring your own model.** The slow path speaks the OpenAI-compatible API. llama.cpp is the default; vLLM, Ollama, LM Studio, or a remote endpoint are config changes, not code changes. Pointing at a remote endpoint is an explicit opt-in.
- **Learns your style — locally.** Accept and reject suggestions and the bridge builds a personal profile from the signal log (SQLite, on your disk): rejected corrections stop being suggested, accepted ones steer the prompt.

### Pipeline

| Stage | Engine | Latency | Catches |
|---|---|---|---|
| Fast path 1 | Harper (Rust, in-process) | ~10 ms | spelling, punctuation, style mechanics |
| Fast path 2 | GECToR-2024 (ONNX INT8, in-process) | ~25 ms CPU | agreement, articles, tense, plurals |
| Escalation | Any OpenAI-compatible LLM | ~300–800 ms | everything the fast path can't prove |

A per-sentence cache skips unchanged text. Deterministic repair chains revert measured LLM over-edit classes — contraction expansion, dialect Americanisation, prescriptivist rewrites — before suggestions reach a client.

### Clients

| Client | |
|---|---|
| Browser extension (WXT MV3, Chrome + Firefox) — overlay, rephrase, synonyms, stats | Ready |
| Vencord plugin — Discord composer underlines, popover, dictionary, rephrase | Ready |
| OpenCode TUI plugin — review card + inline completion ghost in the terminal | Beta |
| Any LanguageTool client — the bridge serves `POST /v2/check` natively | Ready |

### Beyond corrections

Rephrase with alternatives, tone tags, offline synonyms (Moby Thesaurus), inline completion, and a hot-reload user dictionary. Per-category stats with streaks. Dialect-aware checking (British/Canadian/Australian) that stops the LLM from "fixing" your spelling of *colour*.

## Quickstart

Requires Docker and an NVIDIA GPU host for the default llama.cpp backend (CPU-only works — point the bridge at any OpenAI-compatible server).

```bash
# 0. Provision model assets (~4.2 GB GGUF, GECToR INT8 ONNX, MiniLM ONNX,
#    native libs). All plain downloads — no custom export or quantize step.
./scripts/fetch-models.sh

# 1. Local env (edit if you want a non-default LLM endpoint)
cp .env.example .env

# 2. Bring up the stack: bridge + llama.cpp
docker compose up -d

# 3. Check it
curl http://localhost:8000/health
curl -s -X POST http://localhost:8000/v2/check -d "text=I has three cats" -d "language=en-US"
```

To use a different backend, set `GF_LLM_BASE_URL` / `GF_LLM_MODEL` / `GF_LLM_FORMAT` — see the commented BYO blocks in `docker-compose.yml`.

### macOS (Apple Silicon / Metal)

> **Community-verified status** — tested under Docker QEMU emulation on Linux;
> not yet validated on real Apple Silicon hardware. Reports welcome.

Docker Desktop for Mac runs the bridge natively on arm64 (image published from
v0.1.2). The LLM runs on the host with Metal acceleration:

```bash
# 1. Install llama.cpp via Homebrew
brew install llama.cpp

# 2. Provision the model (or point at an existing GGUF)
./scripts/fetch-models.sh

# 3. Start llama.cpp with Metal (offload 99 layers to GPU)
llama-server \
  -m ./models/llm/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf \
  --port 8080 \
  -ngl 99

# 4. Point the bridge at the host Metal server
export GF_LLM_BASE_URL=http://host.docker.internal:8080/v1
docker compose up -d
```

In compose, disable the `llamacpp` service and set `GF_LLM_BASE_URL` — see the
commented macOS/Metal block in `docker-compose.yml`.

### CPU-only

No GPU? Swap the LLM backend to CPU. Two options:

**Option A — CPU llama.cpp** (simplest, keeps the same stack):

```yaml
# docker-compose.override.yml
services:
  llamacpp:
    image: ghcr.io/ggml-org/llama.cpp:server
    deploy: {}  # remove the GPU reservation
```

**Option B — point at any OpenAI-compatible endpoint** (e.g. Ollama). Set in `.env`:

```ini
GF_LLM_BASE_URL=http://host.docker.internal:11434/v1
GF_LLM_MODEL=gemma2:9b
```

Latency: the fast path (Harper + GECToR, ~35 ms) is unaffected. The slow-path LLM goes from ~300–800 ms (GPU) to seconds on CPU. Sentence caching avoids repeated calls; most text clears on the fast path alone.

### Ports

| Service | Host | Endpoint |
|---|---|---|
| Bridge REST | `localhost:8000` | `/correct`, `/rephrase`, `/tone`, `/complete`, `/synonyms`, `/signal`, `/health`, `/stats` — plus LT-compatible `/v2/check` + `/v2/languages` |
| Bridge gRPC | `localhost:8082` | LT `RemoteRule` (only used by the optional LanguageTool profile) |
| LanguageTool | `localhost:8081` | optional compose profile, for LT's native Java rules on top |
| llama.cpp | internal only | clients hit the bridge, never the LLM |

### End-to-end smoke (GPU host)

```bash
./scripts/e2e.sh
```

Builds the stack, waits for health, and asserts corrections surface through both `/v2/check` and `/correct`. Not run in CI (no GPU there).

## Install the clients

Each release ships browser and Vencord packages. The bridge must be running first (Quickstart above).

### Browser (Chrome / Firefox)

Download the latest release from [GitHub Releases](https://github.com/legion-works/grammar-forge/releases).

| Browser | Asset | Install |
|---|---|---|
| Chrome | `grammarforge-browser-<version>-chrome.zip` | `chrome://extensions` → Developer mode → drag the zip (or Load unpacked on the extracted dir). |
| Firefox | `grammarforge-browser-<version>-firefox.zip` | `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select the zip. Unsigned; permanent install requires AMO signing (not yet set up). |

### Vencord (Discord / Vesktop)

Requires a from-source Vencord install ([docs](https://docs.vencord.dev/installing/custom-plugins/)).

```bash
# Download grammarforge-vencord-<version>.zip from the latest release
unzip grammarforge-vencord-<version>.zip -d Vencord/src/userplugins/grammarForge/
cd Vencord && pnpm build
# Restart Discord/Vesktop, enable in Settings → Plugins → GrammarForge
```

### OpenCode

Ships in-tree (`clients/opencode/`). Requires a patched OpenCode core (upstream PR pending). See [clients/opencode/README.md](clients/opencode/README.md).

## Documentation

The eval harness — a 125-case golden set, CoNLL-14 / BEA-19 / JFLEG benchmarks, and a clean-text false-positive gate — lives in [eval/](eval/README.md). Every change to the correction pipeline gates on it. Client-specific docs sit in each client directory.

## Status

Running in production on our hardware, checking real Discord messages and browser text daily; the OpenCode client is built and tested but waits on an upstream TUI hook to go live. Single-user and English-only by design — no auth, no i18n, no cloud sync, and none planned. Young project, single maintainer; interfaces may shift.

## License

AGPL-3.0.

---

<p align="center">
  <img src="handoff/reference/assets/legion-mark.svg" alt="Legion Works" width="16" style="vertical-align: middle">
  &nbsp;A <strong>Legion Works</strong> product. Many programs. One consensus.
</p>
