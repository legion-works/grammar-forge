//go:build cgo && ORT

package semverify

import (
	"context"
	"fmt"
	"os"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/knights-analytics/hugot"
	"github.com/knights-analytics/hugot/backends"
	"github.com/knights-analytics/hugot/options"
	"github.com/knights-analytics/hugot/pipelines"
)

// Verifier embeds text via MiniLM and reports pairwise cosine similarity.
// One hugot Session is held for the process lifetime. Build with -tags ORT.
type Verifier struct {
	session  *hugot.Session
	pipeline *pipelines.FeatureExtractionPipeline
}

// New loads the MiniLM ONNX model + tokenizer from modelPath. The ONNX
// runtime library path is taken from $GF_ORT_LIB_DIR (default /usr/local/lib
// for the container image; bridge/native during local dev). The model
// directory must contain a single .onnx file (typically model.onnx or
// model_quantized.onnx) alongside tokenizer.json — same layout gector uses.
func New(modelPath string) (*Verifier, error) {
	ortDir := os.Getenv("GF_ORT_LIB_DIR")
	if ortDir == "" {
		ortDir = "/usr/local/lib"
	}
	sess, err := hugot.NewORTSession(context.Background(), options.WithOnnxLibraryPath(ortDir))
	if err != nil {
		return nil, fmt.Errorf("hugot session: %w", err)
	}
	cfg := backends.PipelineConfig[*pipelines.FeatureExtractionPipeline]{
		Name:      "minilm",
		ModelPath: modelPath,
		Options: []backends.PipelineOption[*pipelines.FeatureExtractionPipeline]{
			pipelines.WithNormalization(),
		},
	}
	pipe, err := hugot.NewPipeline[*pipelines.FeatureExtractionPipeline](sess, cfg)
	if err != nil {
		_ = sess.Destroy()
		return nil, fmt.Errorf("semverify pipeline: %w", err)
	}
	return &Verifier{session: sess, pipeline: pipe}, nil
}

// Close releases the ONNX session.
func (v *Verifier) Close() error { return v.session.Destroy() }

// Similarity embeds both texts and returns their cosine similarity. Mean
// pooling and L2 normalization happen inside hugot's postprocess so the
// returned vectors already live on the unit sphere and Cosine is the
// standard normalized dot product.
func (v *Verifier) Similarity(ctx context.Context, original, corrected string) (float64, error) {
	out, err := v.pipeline.RunPipeline(ctx, []string{original, corrected})
	if err != nil {
		return 0, fmt.Errorf("semverify inference: %w", err)
	}
	if len(out.Embeddings) < 2 {
		return 0, fmt.Errorf("semverify produced %d embeddings, want 2", len(out.Embeddings))
	}
	return Cosine(out.Embeddings[0], out.Embeddings[1]), nil
}

// Compile-time assertion: *Verifier satisfies correction.SemanticVerifier.
var _ correction.SemanticVerifier = (*Verifier)(nil)
