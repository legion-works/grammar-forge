//go:build cgo && ORT

// Package gector runs the GECToR ONNX model in-process via hugot and implements
// correction.Corrector. One hugot Session is held for the process lifetime.
// Build with -tags ORT.
package gector

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/knights-analytics/hugot"
	"github.com/knights-analytics/hugot/backends"
	"github.com/knights-analytics/hugot/options"
	"github.com/knights-analytics/hugot/pipelines"
)

// GECToR is a process-wide ONNX Corrector. Build with -tags ORT.
type GECToR struct {
	mu       sync.Mutex
	session  *hugot.Session
	pipeline *pipelines.TokenClassificationPipeline
	vocab    VerbVocab
}

// New loads the INT8 ONNX model + tokenizer from modelDir. The ONNX runtime
// library path is taken from $GF_ORT_LIB_DIR (default /usr/local/lib for the
// container image; bridge/native during local dev).
func New(modelDir string) (*GECToR, error) {
	ortDir := os.Getenv("GF_ORT_LIB_DIR")
	if ortDir == "" {
		ortDir = "/usr/local/lib"
	}
	sess, err := hugot.NewORTSession(context.Background(), options.WithOnnxLibraryPath(ortDir))
	if err != nil {
		return nil, fmt.Errorf("hugot session: %w", err)
	}
	cfg := backends.PipelineConfig[*pipelines.TokenClassificationPipeline]{
		Name:      "gector",
		ModelPath: modelDir,
		Options: []backends.PipelineOption[*pipelines.TokenClassificationPipeline]{
			pipelines.WithoutAggregation(), // we group subwords ourselves
		},
	}
	pipe, err := hugot.NewPipeline[*pipelines.TokenClassificationPipeline](sess, cfg)
	if err != nil {
		_ = sess.Destroy()
		return nil, fmt.Errorf("gector pipeline: %w", err)
	}
	vocab, err := loadVerbVocab(modelDir + "/verb-form-vocab.txt")
	if err != nil {
		// non-fatal: decode degrades gracefully (no verb-form corrections)
		vocab = VerbVocab{}
	}
	return &GECToR{session: sess, pipeline: pipe, vocab: vocab}, nil
}

// Close releases the ONNX session.
func (g *GECToR) Close() error { return g.session.Destroy() }

// Name reports the model tag.
func (g *GECToR) Name() correction.Model { return correction.ModelGECToR }

// Correct runs one GECToR pass and returns per-word Suggestions. Each non-KEEP
// word emits one Suggestion whose confidence is the per-token softmax score
// from the underlying hugot entity. The first pass is sufficient for the
// common GECToR-tagged edits (subject-verb agreement, replace, delete, case);
// multi-pass is intentionally not run because it would obscure the per-edit
// confidence we surface to clients.
func (g *GECToR) Correct(ctx context.Context, req correction.Request) ([]correction.Suggestion, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	out, err := g.pipeline.RunPipeline(ctx, []string{req.Text})
	if err != nil {
		return nil, fmt.Errorf("gector inference: %w", err)
	}
	if len(out.Entities) == 0 {
		return nil, nil
	}
	return decodeToSuggestions(req.Text, out.Entities[0], g.vocab)
}
