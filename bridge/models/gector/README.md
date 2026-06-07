# GECToR model bundle (bridge fast path)

This directory holds the **GECToR** ONNX model + tokenizer + supporting files
used by the `internal/gector` package. The files in this directory are
**gitignored** — they are large (the INT8 model is ~397 MB) and derived, and
must be re-fetched in CI / Docker.

## Source

- **Model:** [`gotutiyan/gector-deberta-large-5k`](https://huggingface.co/gotutiyan/gector-deberta-large-5k) — DeBERTa-v3-large backbone fine-tuned for English grammatical error correction (5 001 GECToR tag classes: `$KEEP`, `$DELETE`, `$REPLACE_*`, `$APPEND_*`, `$TRANSFORM_*`).
- **Export + INT8 quantization recipe:** see
  `.opencode/specs/2026-06-07-phase1-risk-spike.md` §P1 — uses
  `optimum-cli onnxruntime quantize --avx512_vnni`.
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
| `model.onnx` | `export/onnx-int8/model_quantized.onnx` (spike) or `optimum-cli onnxruntime quantize` on the exported fp32 model | INT8, ~397 MB |
| `tokenizer.json` | same as above (HuggingFace tokenizer) | Slow tokenizer (sentencepiece), DeBERTa-v1 |
| `config.json` | same as above | DeBERTa-v1 config |
| `labels.json` | same as above | `{ "<id>": "<tag>" }` for the 5001 GECToR classes |
| `specials.json`, `special_tokens_map.json`, `tokenizer_config.json` | same as above | Special-token ids |
| `verb-form-vocab.txt` | `https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt` | ~4.4 MB; required for verb-form transforms |

## CI / Docker fetch

The `bridge/Dockerfile` assumes the model + native libs are present in the
build context. In CI, fetch them BEFORE `docker build`:

```bash
mkdir -p bridge/models/gector bridge/native

# 1. Export + INT8 quantize the model (slow, ~10 min on CPU).
#    See spike §P1 for the export script.
cd bridge/models/gector
curl -fsSL https://huggingface.co/gotutiyan/gector-deberta-large-5k/resolve/main/{tokenizer.json,tokenizer_config.json,special_tokens_map.json,config.json} -o .
# (then run the spike's export_gector.py and optimum quantize)
curl -fsSL https://raw.githubusercontent.com/grammarly/gector/master/data/verb-form-vocab.txt -o .
# Rename model_quantized.onnx -> model.onnx
# Rename labels.json (HuggingFace artefact) — already named correctly
cd -

# 2. Fetch native libs from hugot v0.7.5 release
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libonnxruntime-linux-x64.tar.gz | tar -xz -C bridge/native/
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libtokenizers-linux-x64.tar.gz | tar -xz -C bridge/native/
```

## Test in development

The `internal/gector` test suite skips when `model.onnx` is absent
(`GF_GECTOR_MODEL_DIR` env, default `../../models/gector`). For local
iteration, set the env to point at the spike's export dir:

```bash
GF_GECTOR_MODEL_DIR=~/projects/grammar-forge-spike/p1-gector-hugot/export/onnx-int8 \
  CGO_ENABLED=1 GF_ORT_LIB_DIR=$PWD/native LD_LIBRARY_PATH=$PWD/native \
  go test -tags ORT -v ./internal/gector/
```
