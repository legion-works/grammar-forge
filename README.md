# GrammarForge

Self-hosted, privacy-first grammar and writing assistant. Drop-in replacement
for LanguageTool Premium with custom Vencord + OpenCode integrations and a
local style-learning loop. Full design lives in
[`.opencode/specs/SPEC.md`](.opencode/specs/SPEC.md).

> **Status:** Phase 1 (core stack) complete. The fast path (Harper + GECToR)
> and the slow path (vLLM-served LLM) are wired through LanguageTool's gRPC
> RemoteRule interface. Bring-your-own LLM, single-user, English-only.

## Privacy stance

- **Self-hosted by default.** With the default config, no text leaves the server.
- **Bring-your-own LLM.** The slow path speaks the OpenAI-compatible
  `/v1/chat/completions` API. The default backend is a local vLLM instance
  defined in `docker-compose.yml`. Pointing it at a remote endpoint is an
  explicit user opt-in via `GF_LLM_BASE_URL` / `GF_LLM_API_KEY` in `.env`
  (never commit a real `.env`).
- **No telemetry, no analytics, no phone-home of our own.** The only outbound
  traffic is to the LLM endpoint you configure.
- **No model sidecar.** GECToR and Harper run in-process inside the Go bridge.
  The only runtime services are LanguageTool, the bridge, and the LLM backend.

## Quickstart

Requires Docker, an NVIDIA GPU host (for the default vLLM backend), and
`bridge/native/*` + `bridge/models/` provisioned per
`bridge/models/gector/README.md`.

```bash
# 1. Local env (edit if you want a non-default LLM endpoint)
cp .env.example .env

# 2. Bring up the full stack: LanguageTool -> bridge -> vLLM
docker compose up -d --build

# 3. Point any LanguageTool-compatible client at the local LT port:
#    API endpoint:  http://localhost:8081
#    Or hit the bridge directly:
curl http://localhost:8000/health
```

To run on a CPU-only host, swap the `vllm` service in `docker-compose.yml`
for the commented `ollama` block and set `GF_LLM_BASE_URL=http://ollama:11434/v1`
in `.env`.

## Ports

| Service      | Host             | Endpoint                                     |
| ------------ | ---------------- | -------------------------------------------- |
| LanguageTool | `localhost:8081` | `/v2/check` (LT-compatible)                  |
| Bridge REST  | `localhost:8000` | `/correct`, `/rephrase`, `/signal`, `/health`, `/stats` |
| Bridge gRPC  | `localhost:8082` | LT `RemoteRule` (consumed by LanguageTool)   |
| vLLM         | internal only    | `vllm:8000/v1` (not exposed to the host)     |

Clients hit the bridge, never vLLM.

## End-to-end smoke (GPU host)

The full e2e needs a GPU host and pulls the model weights on first run. It is
**not** run in CI (no GPU); it is a local/dev task:

```bash
./scripts/e2e.sh
```

The script builds the stack, waits for the bridge, vLLM, and LanguageTool to
become healthy, then asserts that a `GF_*` match surfaces from
`GET /v2/check?text=I has three cats and teh dog.` via LanguageTool, and that
`POST /correct` returns suggestions directly. Expected tail output:

```
E2E OK: GrammarForge match present via LanguageTool
```

## Layout

```
bridge/                # Go: gRPC RemoteRule + REST + Harper/GECToR (CGo)
config/                # LanguageTool server.properties + remote-rules.json
docker-compose.yml     # LanguageTool + bridge + vLLM (FP8)
scripts/e2e.sh         # Local GPU-host e2e smoke
```

## Contributing

Issues and PRs welcome. Phase-3 (LoRA fine-tuning from logged corrections) is
the next milestone; client integrations (Vencord plugin, OpenCode LSP shim,
browser-extension fork) follow.

By convention we use [Conventional Commits](https://www.conventionalcommits.org/)
for commit messages.
