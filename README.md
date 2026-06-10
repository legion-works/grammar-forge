# GrammarForge

Self-hosted, privacy-first grammar and writing assistant. Drop-in replacement
for LanguageTool Premium with custom Vencord + OpenCode integrations and a
local style-learning loop. Full design lives in
[`.opencode/specs/SPEC.md`](.opencode/specs/SPEC.md).

> **Status:** Core stack + browser extension working. The fast path
> (Harper + GECToR) and the slow path (llama.cpp-served Gemma-4-E4B QAT GGUF)
> run in-process behind a per-sentence cache, and the bridge serves the
> LanguageTool wire protocol (`/v2/check`) natively — no LanguageTool
> container required (optional compose profile for LT's native Java rules).
> Bring-your-own LLM, single-user, English-only.

## Privacy stance

- **Self-hosted by default.** With the default config, no text leaves the server.
- **Bring-your-own LLM.** The slow path speaks the OpenAI-compatible
  `/v1/chat/completions` API. The default backend is a local llama-server
  instance defined in `docker-compose.yml`. Pointing it at a remote endpoint
  is an explicit user opt-in via `GF_LLM_BASE_URL` / `GF_LLM_API_KEY` in `.env`
  (never commit a real `.env`).
- **No telemetry, no analytics, no phone-home of our own.** The only outbound
  traffic is to the LLM endpoint you configure.
- **No model sidecar.** GECToR and Harper run in-process inside the Go bridge.
  The only runtime services are the bridge and the LLM backend (plus an
  optional LanguageTool container if you enable its compose profile).

## Quickstart

Requires Docker, an NVIDIA GPU host (for the default llama.cpp backend), and
`bridge/native/*` + `bridge/models/` provisioned per
`bridge/models/gector/README.md`.

Before `docker compose up`, place the slow-path GGUF at
`models/llm/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf` (the path is gitignored via
`*.gguf`; download from `unsloth/gemma-4-E4B-it-qat-GGUF` on Hugging Face —
the bridge uses the alias `gemma-4-E4B-it-qat-Q4_K_XL`). The
`scripts/fetch-models.sh` helper automates this and the rest of the asset
provisioning (see step 0 below).

```bash
# 0. Provision model assets (slow-path GGUF, native libs, GECToR support files).
#    Fetches what it can and prints the one manual step (GECToR ONNX export):
./scripts/fetch-models.sh

# 1. Local env (edit if you want a non-default LLM endpoint)
cp .env.example .env

# 2. Bring up the full stack: LanguageTool -> bridge -> llama.cpp
docker compose up -d --build

# 3. Point any LanguageTool-compatible client at the local LT port:
#    API endpoint:  http://localhost:8081
#    Or hit the bridge directly:
curl http://localhost:8000/health
```

To run on a CPU-only host or use a different backend, point the bridge's
`GF_LLM_BASE_URL` / `GF_LLM_MODEL` / `GF_LLM_FORMAT` at any OpenAI-compatible
server (Ollama, vLLM, llama.cpp on CPU, remote) — see the commented BYO
blocks in `docker-compose.yml`.

## Ports

| Service      | Host             | Endpoint                                     |
| ------------ | ---------------- | -------------------------------------------- |
| LanguageTool | `localhost:8081` | `/v2/check` (LT-compatible)                  |
| Bridge REST  | `localhost:8000` | `/correct`, `/rephrase`, `/signal`, `/health`, `/stats` |
| Bridge gRPC  | `localhost:8082` | LT `RemoteRule` (consumed by LanguageTool)   |
| llama.cpp    | internal only    | `llamacpp:8000/v1` (not exposed to the host) |

Clients hit the bridge, never the LLM.

## End-to-end smoke (GPU host)

The full e2e needs a GPU host and pulls the model weights on first run. It is
**not** run in CI (no GPU); it is a local/dev task:

```bash
./scripts/e2e.sh
```

The script builds the stack, waits for the bridge, llama.cpp, and LanguageTool
to become healthy, then asserts that a `GF_*` match surfaces from
`GET /v2/check?text=I has three cats and teh dog.` via LanguageTool, and that
`POST /correct` returns suggestions directly. Expected tail output:

```
E2E OK: GrammarForge match present via LanguageTool
```

## Layout

```
bridge/                # Go: gRPC RemoteRule + REST + Harper/GECToR (CGo)
config/                # LanguageTool server.properties + remote-rules.json
docker-compose.yml     # LanguageTool + bridge + llama.cpp (Gemma-4-E4B QAT GGUF)
models/llm/            # slow-path GGUF (gitignored)
scripts/e2e.sh         # Local GPU-host e2e smoke
```

## Contributing

Issues and PRs welcome. Phase-3 (LoRA fine-tuning from logged corrections) is
the next milestone; client integrations (Vencord plugin, OpenCode LSP shim,
browser-extension fork) follow.

By convention we use [Conventional Commits](https://www.conventionalcommits.org/)
for commit messages.
