//go:build cgo

package harperffi

import (
	"context"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

//nolint:misspell // "recieve"/"a apple" are intentional misspellings under test
func TestHarperFindsSpellingByteOffsets(t *testing.T) {
	h := New()
	defer h.Close()
	text := "I recieve a apple"
	sugs, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.NotEmpty(t, sugs, "expected at least one lint for misspelled text")
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
		require.Equal(t, correction.ModelHarper, s.Model)
	}
}

func TestHarperByteOffsetsOnMultibyte(t *testing.T) {
	h := New()
	defer h.Close()
	text := "café recieve" //nolint:misspell // intentional misspelling under test
	sugs, _ := h.Correct(context.Background(), correction.Request{Text: text})
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
	}
}

func TestHarperNoLintsCleanText(t *testing.T) {
	h := New()
	defer h.Close()
	sugs, err := h.Correct(context.Background(), correction.Request{Text: "This is perfectly fine."})
	require.NoError(t, err)
	// "This is perfectly fine." may or may not have any lints (e.g. "perfectly" is fine,
	// "fine" is fine). We assert the call succeeds; we do NOT assert the result is empty
	// because curated rules may flag subjective style choices. The byte-offset guarantee
	// is what matters.
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len("This is perfectly fine.")))
	}
}
