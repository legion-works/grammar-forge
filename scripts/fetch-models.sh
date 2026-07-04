#!/usr/bin/env bash
# Provision GrammarForge model assets that are plain downloads:
#   - slow-path GGUF (Gemma-4-E4B QAT)         -> models/llm/
#   - hugot native libs (libonnxruntime, etc.) -> bridge/native/
#   - GECToR model + support files + verb-form vocab -> bridge/models/gector/
#   - MiniLM semantic-verifier model + tokenizer     -> bridge/models/minilm/
# All assets are plain downloads — no custom export or quantize step required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLM_DIR="$ROOT/models/llm"
NATIVE_DIR="$ROOT/bridge/native"
GECTOR_DIR="$ROOT/bridge/models/gector"
MINILM_DIR="$ROOT/bridge/models/minilm"
HUGOT_VER="v0.7.5"
GGUF_REPO="unsloth/gemma-4-E4B-it-qat-GGUF"
GGUF_FILE="gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf"
# Meyssa/gector-large-2024 = Grammarly GECToR-2024, RoBERTa-large, Apache-2.0.
# Pre-exported INT8 ONNX — plain download, no Optimum/custom-export step.
# Labels are in config.json id2label (5002 entries); no separate labels.json.
GECTOR_REPO="https://huggingface.co/Meyssa/gector-large-2024/resolve/main"
# sentence-transformers/all-MiniLM-L6-v2 = 6-layer 22M-param MiniLM, Apache-2.0.
# HF ships a plain FP32 ONNX export at onnx/model.onnx — ~90 MB. hugot's
# feature-extraction pipeline mean-pools and L2-normalizes the output, so the
# exported graph is enough; no quantize step is performed here.
MINILM_REPO="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main"

mkdir -p "$LLM_DIR" "$NATIVE_DIR" "$GECTOR_DIR" "$MINILM_DIR"

echo "==> [1/5] Slow-path GGUF ($GGUF_FILE, ~4.2 GB)"
if [ -f "$LLM_DIR/$GGUF_FILE" ]; then
  echo "    present, skipping (delete to re-fetch)"
else
  # Download to a .partial file (resumable) and move into place only on success,
  # so an interrupted download never leaves a corrupt file that the next run skips.
  curl -fL --retry 5 -C - -o "$LLM_DIR/$GGUF_FILE.partial" \
    "https://huggingface.co/$GGUF_REPO/resolve/main/$GGUF_FILE"
  mv "$LLM_DIR/$GGUF_FILE.partial" "$LLM_DIR/$GGUF_FILE"
fi

echo "==> [2/5] hugot native libs ($HUGOT_VER)"
for tarball in libonnxruntime-linux-x64.tar.gz libtokenizers-linux-x64.tar.gz; do
  echo "    $tarball"
  curl -fL --retry 5 \
    "https://github.com/knights-analytics/hugot/releases/download/$HUGOT_VER/$tarball" \
    | tar -xz -C "$NATIVE_DIR"
done

echo "==> [3/5] GECToR model.onnx (~345 MB, INT8, resumable)"
if [ -f "$GECTOR_DIR/model.onnx" ]; then
  echo "    present, skipping (delete to re-fetch)"
else
  # Source path on HuggingFace is onnx/model_quantized.onnx; save as model.onnx.
  curl -fL --retry 5 -C - -o "$GECTOR_DIR/model.onnx.partial" \
    "$GECTOR_REPO/onnx/model_quantized.onnx"
  mv "$GECTOR_DIR/model.onnx.partial" "$GECTOR_DIR/model.onnx"
fi

echo "==> [3/5] GECToR support files (tokenizer/config JSONs)"
for f in config.json tokenizer.json tokenizer_config.json vocab.json merges.txt special_tokens_map.json; do
  echo "    $f"
  curl -fL --retry 5 -o "$GECTOR_DIR/$f" "$GECTOR_REPO/$f"
done

echo "==> [4/5] verb-form vocabulary"
# verb-form-vocab.txt is fetched from grammarly/gector — identical $TRANSFORM_VERB_* tags.
curl -fL --retry 5 -o "$GECTOR_DIR/verb-form-vocab.txt" \
  "https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt"

echo "==> [5/5] MiniLM model.onnx (~90 MB, FP32, resumable)"
if [ -f "$MINILM_DIR/model.onnx" ]; then
  echo "    present, skipping (delete to re-fetch)"
else
  # HF source is onnx/model.onnx; save as model.onnx so hugot's auto-detect
  # finds it as the sole .onnx file in the directory (multiple .onnx files
  # without an explicit OnnxFilename error in hugot.LoadModel).
  curl -fL --retry 5 -C - -o "$MINILM_DIR/model.onnx.partial" \
    "$MINILM_REPO/onnx/model.onnx"
  mv "$MINILM_DIR/model.onnx.partial" "$MINILM_DIR/model.onnx"
fi

echo "==> [5/5] MiniLM tokenizer + config"
for f in tokenizer.json config.json vocab.txt special_tokens_map.json; do
  echo "    $f"
  curl -fL --retry 5 -o "$MINILM_DIR/$f" "$MINILM_REPO/$f"
done

echo "==> fetch-models.sh done."
