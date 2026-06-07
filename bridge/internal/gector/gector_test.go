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
