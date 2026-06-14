# GECToR model bundle (bridge fast path)

This directory holds the **GECToR** ONNX model + tokenizer + supporting files
used by the `internal/gector` package. The files in this directory are
**gitignored** — they are large (the INT8 model is ~345 MB) and must be
re-fetched in CI / Docker via `scripts/fetch-models.sh`.

## Source

- **Model:** [`Meyssa/gector-large-2024`](https://huggingface.co/Meyssa/gector-large-2024) — Grammarly GECToR-2024, RoBERTa-large backbone, **Apache-2.0** license. Pre-exported INT8 ONNX — plain download, no Optimum/custom-export step required. 5 002 GECToR tag classes (`$KEEP`, `$DELETE`, `$REPLACE_*`, `$APPEND_*`, `$TRANSFORM_*`); labels are in `config.json` `id2label` (no separate `labels.json`).
- **Native libraries (`libonnxruntime.so`, `libtokenizers.a`):** the
  `hugot v0.7.5` release for linux-x64:
  <https://github.com/knights-analytics/hugot/releases/tag/v0.7.5>.
  Place them in `bridge/native/` (also gitignored).
- **Verb-form vocabulary:** `verb-form-vocab.txt` is fetched from
  [grammarly/gector](https://github.com/grammarly/gector/blob/master/data/verb-form-vocab.txt)
  — required for `$TRANSFORM_VERB_*` tags. Without it, the decoder gracefully
  skips those tags (degraded quality, no crash).

## Files (what to fetch)

| File | Source | Notes |
|---|---|---|
| `model.onnx` | `Meyssa/gector-large-2024` → `onnx/model_quantized.onnx` | INT8, ~345 MB; plain download |
| `config.json` | `Meyssa/gector-large-2024` | RoBERTa-large config; `id2label` holds all 5002 tag classes |
| `tokenizer.json` | `Meyssa/gector-large-2024` | RoBERTa BPE tokenizer |
| `tokenizer_config.json` | `Meyssa/gector-large-2024` | Tokenizer settings |
| `vocab.json` | `Meyssa/gector-large-2024` | RoBERTa BPE vocabulary |
| `merges.txt` | `Meyssa/gector-large-2024` | RoBERTa BPE merge rules |
| `special_tokens_map.json` | `Meyssa/gector-large-2024` | Special-token ids |
| `verb-form-vocab.txt` | `https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt` | ~4.4 MB; required for verb-form transforms |

## CI / Docker fetch

The `bridge/Dockerfile` assumes the model + native libs are present in the
build context. In CI, fetch them BEFORE `docker build`:

```bash
mkdir -p bridge/models/gector bridge/native

# 1. Fetch GECToR model + support files (all plain downloads).
GECTOR_DIR=bridge/models/gector
GECTOR_REPO="https://huggingface.co/Meyssa/gector-large-2024/resolve/main"

# model.onnx is at onnx/model_quantized.onnx on HuggingFace
curl -fL --retry 5 -C - -o "$GECTOR_DIR/model.onnx.partial" \
  "$GECTOR_REPO/onnx/model_quantized.onnx"
mv "$GECTOR_DIR/model.onnx.partial" "$GECTOR_DIR/model.onnx"

for f in config.json tokenizer.json tokenizer_config.json vocab.json merges.txt special_tokens_map.json; do
  curl -fL --retry 5 -o "$GECTOR_DIR/$f" "$GECTOR_REPO/$f"
done

curl -fL --retry 5 -o "$GECTOR_DIR/verb-form-vocab.txt" \
  "https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt"

# 2. Fetch native libs from hugot v0.7.5 release
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libonnxruntime-linux-x64.tar.gz | tar -xz -C bridge/native/
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libtokenizers-linux-x64.tar.gz | tar -xz -C bridge/native/
```

## Test in development

The `internal/gector` test suite skips when `model.onnx` is absent
(`GF_GECTOR_MODEL_DIR` env, default `../../models/gector`). For local
iteration, set the env to point at the staged model dir:

```bash
GF_GECTOR_MODEL_DIR=~/projects/grammar-forge-spike/gector2024/hugot-layout \
  CGO_ENABLED=1 GF_ORT_LIB_DIR=$PWD/native LD_LIBRARY_PATH=$PWD/native \
  go test -tags ORT -v ./internal/gector/
```

## Gitignore + native libs note

All model weight files (`*.onnx`, `*.gguf`, `vocab.json`, `merges.txt`,
`tokenizer*.json`, `config.json`, `verb-form-vocab.txt`) are gitignored via
the root `.gitignore`. Only this `README.md` is tracked. Native libs
(`bridge/native/`) are similarly gitignored — fetch via `scripts/fetch-models.sh`.
