//go:build cgo && ORT

// Package gector runs the GECToR ONNX model in-process via hugot and implements
// correction.Corrector. One hugot Session is held for the process lifetime.
// Build with -tags ORT.
package gector

import (
	"context"
	"fmt"
	"log/slog"
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
	// passes is how many inference passes Correct runs (Task 7,
	// GF_GECTOR_PASSES). Set via SetPasses; New leaves it at the default 1.
	passes int
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
	return &GECToR{session: sess, pipeline: pipe, vocab: vocab, passes: 1}, nil
}

// Close releases the ONNX session.
func (g *GECToR) Close() error { return g.session.Destroy() }

// Name reports the model tag.
func (g *GECToR) Name() correction.Model { return correction.ModelGECToR }

// SetPasses sets how many GECToR inference passes Correct runs per request
// (Task 7, GF_GECTOR_PASSES). Mirrors the correction.Service Set* setter
// convention (e.g. SetSentenceContext). Never called => passes stays at New's
// default of 1, i.e. today's single-pass behaviour. Values below 1 are
// floored to 1 defensively; config.Load is the source of truth for the
// [1,3] upper clamp (see config.Config.GECToRPasses), so a caller that goes
// through config is already bounded before it reaches here.
func (g *GECToR) SetPasses(n int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if n < 1 {
		n = 1
	}
	g.passes = n
}

// identityBack is the starting translator for Correct's pass loop: before
// any extra pass has run, currentText IS req.Text, so a span translates to
// itself.
func identityBack(start, end int) (int, int, bool) { return start, end, true }

// Correct runs one or more GECToR inference passes and returns per-word
// Suggestions, merged across passes and translated back to req.Text
// (original) byte coordinates.
//
// Passes (Task 7, GF_GECTOR_PASSES, default 1): pass 1 is EXACTLY today's
// single-pass behaviour — run the pipeline against req.Text, decode, return.
// With passes==1 (or an empty first-pass result) the extra-pass loop body
// below never runs, so the default is byte-identical to the pre-Task-7
// output. Extra passes (opt-in via SetPasses) re-run the pipeline against
// the text produced by APPLYING the previous passes' suggestions, to catch
// edits GECToR only surfaces once an earlier edit is already in place (e.g.
// an agreement fix that only becomes visible after a verb-form fix is
// applied). Default stays 1 for two reasons: (a) per-edit confidence is
// clearest when every edit is judged against the user's real, unmodified
// text — a pass-2+ edit's softmax score is computed against a sentence the
// user never actually wrote; (b) latency grows roughly linearly with pass
// count (one extra model invocation per pass). The knob exists so the
// recall measurement matrix (GF_GECTOR_PASSES=2/3) can quantify the
// recall/latency/confidence-purity tradeoff before any deploy opts in.
//
// Coordinate invariant: every suggestion this method returns is in req.Text
// (original) byte coordinates — never in an intermediate pass's text
// coordinates. currentText is the text the NEXT pass's pipeline runs
// against (starts as req.Text); backToOriginal translates a byte span in
// currentText back to req.Text coordinates (starts as identityBack). For
// each pass: (1) run the pipeline + decode against currentText — those
// suggestion spans are in CURRENT-text coordinates; (2) translate each
// through backToOriginal into req.Text coordinates for the merged result,
// dropping (and counting) any suggestion whose span has no original
// equivalent — i.e. it falls strictly inside a byte range an earlier pass
// replaced (see remap.go's applyAndTrack); (3) to prepare the NEXT pass,
// apply THIS pass's CURRENT-text-coordinate suggestions — BEFORE
// translation — to currentText via applyAndTrack, then compose
// backToOriginal with the resulting translator. Applying already-translated
// (original-coordinate) suggestions to currentText would silently mix
// coordinate spaces; that is the exact bug this invariant exists to
// prevent. The loop stops early once a pass yields zero suggestions.
//
// Calibration note: later-pass suggestions keep their own softmax
// Confidence, Model: ModelGECToR, and Category like any other suggestion —
// there is no pass-identity dimension in the P2 (model, category)
// calibration bucket scheme (see correction.ConfidenceCalibrator). Adding
// one was considered and rejected: it would fragment an already sparse
// acceptance-signal dataset. This is an accepted, documented limitation —
// a multi-pass edit calibrates in the same bucket as a pass-1 edit of the
// same category.
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
	firstPass, err := decodeToSuggestions(req.Text, out.Entities[0], g.vocab)
	if err != nil {
		return nil, err
	}
	if g.passes <= 1 || len(firstPass) == 0 {
		return firstPass, nil
	}

	passesOut := [][]correction.Suggestion{firstPass}
	currentText := req.Text
	backToOriginal := identityBack
	// lastSugs holds the most recently decoded pass's suggestions in
	// CURRENT-text coordinates (untranslated) — these, not the translated
	// ones, are what applyAndTrack must consume to build the next pass's
	// text.
	lastSugs := firstPass

	for pass := 2; pass <= g.passes; pass++ {
		// Step 3 (for the previous pass): prepare this pass's currentText
		// and backToOriginal from lastSugs (current-text-coordinate,
		// untranslated).
		nextText, back := applyAndTrack(currentText, lastSugs)
		// Capture the OLD closure in a local FIRST: a closure that
		// referenced backToOriginal directly (the variable being
		// reassigned) would recurse into itself once reassigned.
		previousBack := backToOriginal
		thisBack := back
		backToOriginal = func(s, e int) (int, int, bool) {
			ms, me, ok := thisBack(s, e)
			if !ok {
				return 0, 0, false
			}
			return previousBack(ms, me)
		}
		currentText = nextText

		// Step 1: run the pipeline + decode against currentText.
		passOut, err := g.pipeline.RunPipeline(ctx, []string{currentText})
		if err != nil {
			return nil, fmt.Errorf("gector inference (pass %d): %w", pass, err)
		}
		if len(passOut.Entities) == 0 {
			break
		}
		sugs, err := decodeToSuggestions(currentText, passOut.Entities[0], g.vocab)
		if err != nil {
			return nil, err
		}
		if len(sugs) == 0 {
			break
		}

		// Step 2: translate this pass's suggestions into req.Text
		// coordinates, dropping any with no original-text equivalent.
		translated := make([]correction.Suggestion, 0, len(sugs))
		droppedRemapCount := 0
		for _, s := range sugs {
			os, oe, ok := backToOriginal(s.Span.Start, s.Span.End)
			if !ok {
				droppedRemapCount++
				continue
			}
			s.Span = correction.Span{Start: os, End: oe}
			translated = append(translated, s)
		}
		if droppedRemapCount > 0 {
			slog.Default().Debug("gector: pass suggestions dropped (no original-text equivalent)",
				"pass", pass, "count", droppedRemapCount)
		}
		passesOut = append(passesOut, translated)
		lastSugs = sugs
	}

	return mergePasses(passesOut), nil
}
