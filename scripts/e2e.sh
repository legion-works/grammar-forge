#!/usr/bin/env bash
# End-to-end smoke for the GrammarForge stack. Requires an NVIDIA GPU host and
# the bridge build context (bridge/native/*, bridge/models/) present.
# First vLLM start downloads the model — be patient.
set -euo pipefail

cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> building + starting stack"
docker compose up -d --build

echo "==> waiting for bridge /health"
# shellcheck disable=SC2034  # i is the bounded-retry counter; the body breaks early.
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8000/health; echo

echo "==> waiting for vLLM (model load can take minutes on first run)"
# shellcheck disable=SC2034
for i in $(seq 1 180); do
  if curl -fsS http://127.0.0.1:8000/stats >/dev/null 2>&1 \
     && docker compose logs vllm 2>/dev/null | grep -q "Application startup complete"; then break; fi
  sleep 5
done

echo "==> bridge /correct (direct)"
curl -fsS -X POST http://127.0.0.1:8000/correct \
  -d '{"text":"She go to the store yesterday and buyed some apple.","source":"vencord"}'; echo

echo "==> waiting for LanguageTool"
# shellcheck disable=SC2034
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:8081/v2/languages" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "==> LanguageTool /v2/check (should include a GF_ rule match)"
RESP=$(curl -fsS "http://127.0.0.1:8081/v2/check" --data-urlencode "language=en-US" --data-urlencode "text=I has three cats and teh dog.")
echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); ids=[m['rule']['id'] for m in d['matches']]; print('rule ids:', ids); assert any(i.startswith('GF_') for i in ids), 'no GrammarForge match surfaced'; print('E2E OK: GrammarForge match present via LanguageTool')"
