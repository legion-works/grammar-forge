package correction

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSegmentSentencesOffsets(t *testing.T) {
	text := "I has a cat. She go to school every day! Does he knows?"
	segs := SegmentSentences(text)
	require.Len(t, segs, 3)
	require.Equal(t, "I has a cat.", strings.TrimSpace(text[segs[0].Start:segs[0].End]))
	require.Equal(t, "She go to school every day!", strings.TrimSpace(text[segs[1].Start:segs[1].End]))
	require.Equal(t, "Does he knows?", strings.TrimSpace(text[segs[2].Start:segs[2].End]))
}

func TestSegmentSentencesMonotonicNonOverlapping(t *testing.T) {
	text := "First. Second sentence here. Third one, with a comma. And a fourth."
	segs := SegmentSentences(text)
	require.GreaterOrEqual(t, len(segs), 2)
	for i := 1; i < len(segs); i++ {
		require.GreaterOrEqual(t, segs[i].Start, segs[i-1].End, "segments must not overlap and must be ordered")
	}
	for _, s := range segs {
		require.LessOrEqual(t, s.End, len(text))
		require.Less(t, s.Start, s.End)
	}
}

func TestSegmentSentencesAbbreviationsDontOverSplit(t *testing.T) {
	text := "Dr. Smith lives in the U.S. and likes it. He really does."
	segs := SegmentSentences(text)
	require.Len(t, segs, 2, "punkt must not split on Dr. / U.S.")
}

func TestSegmentSentencesSingleSentence(t *testing.T) {
	segs := SegmentSentences("Just one sentence here")
	require.Len(t, segs, 1)
}

func TestSegmentSentencesEmptyAndWhitespace(t *testing.T) {
	require.Empty(t, SegmentSentences(""))
	require.Empty(t, SegmentSentences("   \n  "))
}

func TestSegmentSentencesCodeLikeInputStaysWhole(t *testing.T) {
	// Punkt happily splits code at '?' / '.' (e.g. "arr.length"), and a code
	// FRAGMENT sent to the LLM alone gets "corrected" differently than the
	// whole line (live regression: "arr[0] : null;" -> "arr[0]: null"). Code-
	// like input must bypass segmentation (single whole-text segment =
	// pre-sentence-pipeline behaviour).
	for _, text := range []string{
		"i++; return arr.length > 0 ? arr[0] : null;",
		"const x = items.filter((i) => i.ok); doIt(x);",
		"if (a == b && c != d) { return; }",
	} {
		segs := SegmentSentences(text)
		require.Len(t, segs, 1, "code-like input must not be segmented: %q", text)
	}
}

func TestSegmentSentencesProseWithOneSemicolonStillSplits(t *testing.T) {
	// A single semicolon is normal prose punctuation and must NOT trigger the
	// code bypass.
	text := "I like tea; it calms me. She prefers coffee in the morning."
	require.Len(t, SegmentSentences(text), 2)
}

func TestSegmentSentencesSplitsOnNewlineHardBoundary(t *testing.T) {
	// "line one\nline two" must yield two segments, the '\n' byte uncovered.
	text := "line one\nline two"
	segs := SegmentSentences(text)
	require.Len(t, segs, 2, "hard newline must be a sentence boundary")
	require.Equal(t, "line one", text[segs[0].Start:segs[0].End])
	require.Equal(t, "line two", text[segs[1].Start:segs[1].End])
	require.Equal(t, 0, segs[0].Start)
	require.Equal(t, 8, segs[0].End, "seg[0] ends at '\n' index, not past it")
	require.Equal(t, 9, segs[1].Start, "seg[1] starts AFTER the '\n'")
	require.Equal(t, 17, segs[1].End)
}

func TestSegmentSentencesBlankLineProducesNoEmptySegment(t *testing.T) {
	// "a\n\nb" must yield exactly two non-empty segments, no empty.
	text := "a\n\nb"
	segs := SegmentSentences(text)
	require.Len(t, segs, 2, "blank line must not produce an empty segment")
	for i, s := range segs {
		require.Greater(t, s.End, s.Start, "seg %d must be non-empty", i)
	}
}

func TestSegmentSentencesPunktStillSplitsWithinLine(t *testing.T) {
	// A multi-sentence LINE still splits via punkt; the '\n' is the OUTER
	// boundary, not the inner one. The whole-line punctuation contract holds.
	text := "Hello world. Bye.\nNext line."
	segs := SegmentSentences(text)
	require.Len(t, segs, 3, "two sentences on line 1 + one on line 2")
	require.Equal(t, "Hello world.", text[segs[0].Start:segs[0].End])
	require.Equal(t, "Bye.", text[segs[1].Start:segs[1].End])
	require.Equal(t, "Next line.", text[segs[2].Start:segs[2].End])
	// Verify offsets against the ORIGINAL text — no shift bugs.
	require.Equal(t, 0, segs[0].Start)
	require.Equal(t, 12, segs[0].End)
	require.Equal(t, 13, segs[1].Start)
	require.Equal(t, 17, segs[1].End)
	require.Equal(t, 18, segs[2].Start)
	require.Equal(t, 28, segs[2].End)
}

func TestSegmentSentencesLeadingAndTrailingNewlines(t *testing.T) {
	// Leading/trailing '\n' must not produce empty segments at the edges.
	for _, tc := range []struct {
		name string
		text string
	}{
		{"leading", "\nhello there"},
		{"trailing", "hello there\n"},
		{"both", "\nhello there\n"},
		{"crlf_trailing", "hello there\r\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			segs := SegmentSentences(tc.text)
			require.NotEmpty(t, segs)
			for i, s := range segs {
				require.Greater(t, s.End, s.Start, "seg %d must be non-empty", i)
			}
		})
	}
}

func TestSegmentSentencesSingleLineByteIdenticalRegression(t *testing.T) {
	// Single-line input (no '\n') must behave EXACTLY as today — pre-punkt
	// whole-text path, no offsets change. This is the regression contract:
	// the single-line golden-eval cases must stay 125/125 unchanged.
	text := "I has a cat. She go to school every day! Does he knows?"
	segs := SegmentSentences(text)
	require.Len(t, segs, 3)
	require.Equal(t, "I has a cat.", strings.TrimSpace(text[segs[0].Start:segs[0].End]))
	require.Equal(t, "She go to school every day!", strings.TrimSpace(text[segs[1].Start:segs[1].End]))
	require.Equal(t, "Does he knows?", strings.TrimSpace(text[segs[2].Start:segs[2].End]))
}

func TestSegmentSentencesNewlineCoverageGapIsExactlyOneByte(t *testing.T) {
	// The text bytes NOT covered by any returned segment must be EXACTLY the
	// '\n' bytes — no more, no less. This is the load-bearing assertion: any
	// byte the LLM could see inside a segment must NOT be a '\n'.
	text := "alpha\nbeta\ngamma"
	segs := SegmentSentences(text)
	covered := make([]bool, len(text))
	for _, s := range segs {
		for i := s.Start; i < s.End; i++ {
			covered[i] = true
		}
	}
	for i, c := range covered {
		if text[i] == '\n' {
			require.False(t, c, "byte %d is '\\n' — must be uncovered", i)
		} else {
			require.True(t, c, "byte %d (%q) must be covered by some segment", i, text[i])
		}
	}
}

func TestSegmentSentencesCRLFStripsCarriageReturn(t *testing.T) {
	// "a\r\nb" must treat the '\r' as part of the line break and leave no
	// '\r' at the end of a segment. Punkt sees "a" and "b" only.
	text := "a\r\nb"
	segs := SegmentSentences(text)
	require.Len(t, segs, 2, "CRLF is one boundary, not two")
	for i, s := range segs {
		got := text[s.Start:s.End]
		require.NotContains(t, got, "\r", "seg %d must not contain a '\\r'", i)
	}
}

func TestSegmentSentencesMultiLineLooksLikeCodeFallsBackPerLine(t *testing.T) {
	// Per-line looksLikeCode must catch codey line content even when the
	// text has a '\n' the looksLikeCode pass wouldn't see today.
	text := "i++; return arr.length > 0 ? arr[0] : null;\nconst x = items.filter((i) => i.ok);"
	segs := SegmentSentences(text)
	require.Len(t, segs, 2, "each codey line is one whole-text segment")
	require.Equal(t, 0, segs[0].Start)
	require.Equal(t, 43, segs[0].End)
	require.Equal(t, 44, segs[1].Start)
	require.Equal(t, len(text), segs[1].End)
}
