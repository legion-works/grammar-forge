# MiniLM semantic-verifier model bundle

This directory holds the **MiniLM** ONNX model + tokenizer used by
`internal/semverify` (the post-LLM semantic verifier gate). Files are
**gitignored** — they are large (the FP32 ONNX is ~90 MB) and must be
re-fetched in CI / Docker via `scripts/fetch-models.sh`.

## Source

- **Model:** [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
  — 6-layer 22M-param MiniLM, **Apache-2.0** license. HF ships a plain FP32
  ONNX export at `onnx/model.onnx`. hugot's feature-extraction pipeline
  mean-pools and L2-normalizes the output, so the exported graph is enough
  — no quantize step required here.
- **Native libraries** (`libonnxruntime.so`, `libtokenizers.a`): the
  `hugot v0.7.5` release for linux-x64:
  <https://github.com/knights-analytics/hugot/releases/tag/v0.7.5>.
  Place them in `bridge/native/` (also gitignored).

## Files (what to fetch)

| File | Source | Notes |
|---|---|---|
| `model.onnx` | `sentence-transformers/all-MiniLM-L6-v2` → `onnx/model.onnx` | FP32, ~90 MB; plain download |
| `tokenizer.json` | same | HuggingFace fast tokenizer |
| `config.json` | same | MiniLM config |
| `vocab.txt` | same | WordPiece vocabulary |
| `special_tokens_map.json` | same | Special-token ids |

## CI / Docker fetch

The `bridge/Dockerfile` assumes the model + native libs are present in the
build context. In CI, fetch them BEFORE `docker build`:

```bash
mkdir -p bridge/models/minilm bridge/native

MINILM_DIR=bridge/models/minilm
MINILM_REPO="https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main"

curl -fL --retry 5 -C - -o "$MINILM_DIR/model.onnx.partial" \
  "$MINILM_REPO/onnx/model.onnx"
mv "$MINILM_DIR/model.onnx.partial" "$MINILM_DIR/model.onnx"

for f in tokenizer.json config.json vocab.txt special_tokens_map.json; do
  curl -fL --retry 5 -o "$MINILM_DIR/$f" "$MINILM_REPO/$f"
done

# 2. Fetch native libs from hugot v0.7.5 release
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libonnxruntime-linux-x64.tar.gz | tar -xz -C bridge/native/
curl -fsSL https://github.com/knights-analytics/hugot/releases/download/v0.7.5/libtokenizers-linux-x64.tar.gz | tar -xz -C bridge/native/
```

## Calibration study

The threshold that the verifier uses is calibrated by
`eval/verifier_calibration.py` (see `eval/README.md` §5). The Go probe
binary `semverify-probe` lives at `bridge/cmd/semverify-probe/` and
validates that the Python reference and the production hugot path produce
cosines within ~0.02 per pair.

## Gitignore + native libs note

All model weight files (`*.onnx`, `*.gguf`, `vocab.json`, `merges.txt`,
`tokenizer*.json`, `config.json`, `verb-form-vocab.txt`) are gitignored via
the root `.gitignore`. Only this `README.md` is tracked. Native libs
(`bridge/native/`) are similarly gitignored — fetch via `scripts/fetch-models.sh`.
