#!/usr/bin/env bash
# Provision GrammarForge model assets that are plain downloads:
#   - slow-path GGUF (Gemma-4-E4B QAT)         -> models/llm/
#   - hugot native libs (libonnxruntime, etc.) -> bridge/native/
#   - GECToR support files + verb-form vocab   -> bridge/models/gector/
# The GECToR model.onnx itself needs a custom export+INT8 quantize (NOT a plain
# download); this script prints the instruction for that one manual step.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLM_DIR="$ROOT/models/llm"
NATIVE_DIR="$ROOT/bridge/native"
GECTOR_DIR="$ROOT/bridge/models/gector"
HUGOT_VER="v0.7.5"
GGUF_REPO="unsloth/gemma-4-E4B-it-qat-GGUF"
GGUF_FILE="gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf"

mkdir -p "$LLM_DIR" "$NATIVE_DIR" "$GECTOR_DIR"

echo "==> [1/4] Slow-path GGUF ($GGUF_FILE, ~4.2 GB)"
if [ -f "$LLM_DIR/$GGUF_FILE" ]; then
  echo "    present, skipping (delete to re-fetch)"
else
  # Download to a .partial file (resumable) and move into place only on success,
  # so an interrupted download never leaves a corrupt file that the next run skips.
  curl -fL --retry 5 -C - -o "$LLM_DIR/$GGUF_FILE.partial" \
    "https://huggingface.co/$GGUF_REPO/resolve/main/$GGUF_FILE"
  mv "$LLM_DIR/$GGUF_FILE.partial" "$LLM_DIR/$GGUF_FILE"
fi

echo "==> [2/4] hugot native libs ($HUGOT_VER)"
for tarball in libonnxruntime-linux-x64.tar.gz libtokenizers-linux-x64.tar.gz; do
  echo "    $tarball"
  curl -fL --retry 5 \
    "https://github.com/knights-analytics/hugot/releases/download/$HUGOT_VER/$tarball" \
    | tar -xz -C "$NATIVE_DIR"
done

echo "==> [3/4] GECToR support files (tokenizer/config JSONs)"
GECTOR_REPO="https://huggingface.co/gotutiyan/gector-deberta-large-5k/resolve/main"
for f in tokenizer.json tokenizer_config.json special_tokens_map.json config.json; do
  echo "    $f"
  curl -fL --retry 5 -o "$GECTOR_DIR/$f" "$GECTOR_REPO/$f"
done

echo "==> [4/4] verb-form vocabulary"
curl -fL --retry 5 -o "$GECTOR_DIR/verb-form-vocab.txt" \
  "https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt"

cat <<'NOTE'

==> MANUAL STEP REMAINING: GECToR model.onnx
    model.onnx (INT8, ~397 MB) is a custom ONNX export of
    gotutiyan/gector-deberta-large-5k (DeBERTa-v1, custom heads) + optimum INT8
    quantize. It is NOT a plain download. See the recipe in:
      bridge/models/gector/README.md
    Place the result at bridge/models/gector/model.onnx (+ labels.json).

==> Native libs and GGUF are in place. After the GECToR export, the bridge can
    build with -tags ORT and the stack can run via docker compose.
NOTE

echo "==> fetch-models.sh done."
