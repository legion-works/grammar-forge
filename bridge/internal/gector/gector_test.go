//go:build cgo && ORT

package gector

import (
	"context"
	"os"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// modelDir returns the GECToR model dir (env override, or ../../models/gector
// relative to the test dir). Skips the test if model.onnx is absent.
func modelDir(t *testing.T) string {
	t.Helper()
	d := os.Getenv("GF_GECTOR_MODEL_DIR")
	if d == "" {
		d = "../../models/gector"
	}
	if _, err := os.Stat(d + "/model.onnx"); err != nil {
		t.Skipf("GECToR model not present at %s; skipping", d)
	}
	return d
}

func TestGECToRCorrectsStructuralErrors(t *testing.T) {
	if os.Getenv("GF_ORT_LIB_DIR") == "" {
		t.Setenv("GF_ORT_LIB_DIR", "../../native")
	}
	g, err := New(modelDir(t))
	require.NoError(t, err)
	defer func() { _ = g.Close() }()

	const in = "I has three cats"
	sugs, err := g.Correct(context.Background(), correction.Request{Text: in})
	require.NoError(t, err)
	require.NotEmpty(t, sugs, "GECToR should produce at least one suggestion for %q", in)
	out := in
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	require.Equal(t, "I have three cats", out, "GECToR should turn %q into %q", in, "I have three cats")
}

func TestGECToRSuggestionConfidenceFromInference(t *testing.T) {
	if os.Getenv("GF_ORT_LIB_DIR") == "" {
		t.Setenv("GF_ORT_LIB_DIR", "../../native")
	}
	g, err := New(modelDir(t))
	require.NoError(t, err)
	defer func() { _ = g.Close() }()

	const in = "I has three cats"
	sugs, err := g.Correct(context.Background(), correction.Request{Text: in})
	require.NoError(t, err)
	require.NotEmpty(t, sugs)
	allHardcoded := true
	for _, s := range sugs {
		require.Greater(t, s.Confidence, 0.0, "GECToR confidence must be > 0 (was %v on %+v)", s.Confidence, s)
		require.LessOrEqual(t, s.Confidence, 1.0, "GECToR confidence must be <= 1.0 (was %v on %+v)", s.Confidence, s)
		if s.Confidence != 0.9 {
			allHardcoded = false
		}
	}
	require.False(t, allHardcoded, "GECToR confidence is hardcoded 0.9; must come from inference")
}

func TestGECToRSpanByteOffsets(t *testing.T) {
	if os.Getenv("GF_ORT_LIB_DIR") == "" {
		t.Setenv("GF_ORT_LIB_DIR", "../../native")
	}
	g, err := New(modelDir(t))
	require.NoError(t, err)
	defer func() { _ = g.Close() }()

	const in = "He go to school."
	sugs, err := g.Correct(context.Background(), correction.Request{Text: in})
	require.NoError(t, err)
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(in)), "GECToR suggestion has invalid byte span: %+v on %q", s, in)
	}
}

func TestGECToRAppliesVerbFormTransform(t *testing.T) {
	// Spike FINDINGS.md §3 documents two verb-form inputs that the model
	// EMITS a $TRANSFORM_VERB_* tag for but the spike could not APPLY (no
	// vocab). Of those two, "I seen it yesterday." (VBN -> VBD on "seen"
	// -> "saw") is the one the model actually fires for in this build: the
	// argmax label for "seen" is $TRANSFORM_VERB_VBN_VBD. The other
	// ("He go to school every day." -> "goes") the model marks $KEEP at
	// 0.635 confidence, so the argmax path produces no suggestion (which
	// is the model's correct decision; an LLM escalation would handle it).
	//
	// With verb-form-vocab.txt loaded, the decoder must apply the
	// $TRANSFORM_VERB_VBN_VBD tag on "seen" -> "saw".
	if os.Getenv("GF_ORT_LIB_DIR") == "" {
		t.Setenv("GF_ORT_LIB_DIR", "../../native")
	}
	g, err := New(modelDir(t))
	require.NoError(t, err)
	defer func() { _ = g.Close() }()

	const in = "I seen it yesterday."
	sugs, err := g.Correct(context.Background(), correction.Request{Text: in})
	require.NoError(t, err)
	require.NotEmpty(t, sugs, "GECToR should fire $TRANSFORM_VERB_VBN_VBD on 'seen' in %q", in)
	out := in
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	require.Equal(t, "I saw it yesterday.", out, "GECToR should turn %q into %q with the verb-form vocab loaded", in, "I saw it yesterday.")
}
