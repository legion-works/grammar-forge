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
