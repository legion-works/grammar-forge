package gector

import (
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// spanOf locates word's first occurrence in text and returns its byte Span.
// Test helper only — fails the test if word is not found.
func spanOf(t *testing.T, text, word string) correction.Span {
	t.Helper()
	i := strings.Index(text, word)
	require.GreaterOrEqualf(t, i, 0, "expected %q to contain %q", text, word)
	return correction.Span{Start: i, End: i + len(word)}
}

func TestApplyAndTrack_Identity(t *testing.T) {
	text := "hello world"
	corrected, back := applyAndTrack(text, nil)
	require.Equal(t, text, corrected)

	cases := [][2]int{{0, 5}, {6, 11}, {0, 11}, {0, 0}, {11, 11}, {3, 8}}
	for _, c := range cases {
		os, oe, ok := back(c[0], c[1])
		require.True(t, ok)
		require.Equal(t, c[0], os)
		require.Equal(t, c[1], oe)
	}
}

func TestApplyAndTrack_SingleReplacement_EqualLength(t *testing.T) {
	text := "I go to school"
	goSpan := spanOf(t, text, "go")
	corrected, back := applyAndTrack(text, []correction.Suggestion{{Span: goSpan, Replacement: "do"}})
	require.Equal(t, "I do to school", corrected)

	doSpan := spanOf(t, corrected, "do")
	os, oe, ok := back(doSpan.Start, doSpan.End)
	require.True(t, ok)
	require.Equal(t, goSpan.Start, os)
	require.Equal(t, goSpan.End, oe)

	// unaffected trailing text still translates by (zero, here) offset.
	schoolCorrected := spanOf(t, corrected, "school")
	schoolOrig := spanOf(t, text, "school")
	os, oe, ok = back(schoolCorrected.Start, schoolCorrected.End)
	require.True(t, ok)
	require.Equal(t, schoolOrig.Start, os)
	require.Equal(t, schoolOrig.End, oe)
}

func TestApplyAndTrack_SingleReplacement_Longer(t *testing.T) {
	text := "I go to school"
	goSpan := spanOf(t, text, "go")
	corrected, back := applyAndTrack(text, []correction.Suggestion{{Span: goSpan, Replacement: "went"}})
	require.Equal(t, "I went to school", corrected)

	wentSpan := spanOf(t, corrected, "went")
	os, oe, ok := back(wentSpan.Start, wentSpan.End)
	require.True(t, ok)
	require.Equal(t, goSpan.Start, os)
	require.Equal(t, goSpan.End, oe)

	schoolCorrected := spanOf(t, corrected, "school")
	schoolOrig := spanOf(t, text, "school")
	os, oe, ok = back(schoolCorrected.Start, schoolCorrected.End)
	require.True(t, ok)
	require.Equal(t, schoolOrig.Start, os)
	require.Equal(t, schoolOrig.End, oe)
}

func TestApplyAndTrack_SingleReplacement_Shorter(t *testing.T) {
	text := "I go to school"
	schoolSpan := spanOf(t, text, "school")
	corrected, back := applyAndTrack(text, []correction.Suggestion{{Span: schoolSpan, Replacement: "class"}})
	require.Equal(t, "I go to class", corrected)

	classSpan := spanOf(t, corrected, "class")
	os, oe, ok := back(classSpan.Start, classSpan.End)
	require.True(t, ok)
	require.Equal(t, schoolSpan.Start, os)
	require.Equal(t, schoolSpan.End, oe)
}

func TestApplyAndTrack_Insertion(t *testing.T) {
	text := "I go to school"
	goSpan := spanOf(t, text, "go")
	// Zero-width insertion immediately before "go".
	ins := correction.Suggestion{Span: correction.Span{Start: goSpan.Start, End: goSpan.Start}, Replacement: "really "}
	corrected, back := applyAndTrack(text, []correction.Suggestion{ins})
	require.Equal(t, "I really go to school", corrected)

	reallySpan := spanOf(t, corrected, "really ")
	// Touching the whole inserted run translates exactly to the zero-width
	// insertion point in the original text.
	os, oe, ok := back(reallySpan.Start, reallySpan.End)
	require.True(t, ok)
	require.Equal(t, goSpan.Start, os)
	require.Equal(t, goSpan.Start, oe)

	// Strictly inside the inserted text has no original equivalent.
	_, _, ok = back(reallySpan.Start+1, reallySpan.End-1)
	require.False(t, ok)
}

func TestApplyAndTrack_Deletion(t *testing.T) {
	text := "ab cd ef"
	delSpan := spanOf(t, text, "cd ")
	corrected, back := applyAndTrack(text, []correction.Suggestion{{Span: delSpan, Replacement: ""}})
	require.Equal(t, "ab ef", corrected)

	// The zero-width point in corrected text where the deletion happened
	// translates exactly to the deletion's original START (left-edge
	// convention: touching a replacement/deletion resolves via its
	// original-start boundary).
	os, oe, ok := back(delSpan.Start, delSpan.Start)
	require.True(t, ok)
	require.Equal(t, delSpan.Start, os)
	require.Equal(t, delSpan.Start, oe)

	// A span that starts before the deletion and ends at the deletion point
	// covers exactly the unchanged prefix.
	os, oe, ok = back(0, delSpan.Start)
	require.True(t, ok)
	require.Equal(t, 0, os)
	require.Equal(t, delSpan.Start, oe)

	// A span from the deletion point to the end of corrected text recovers
	// the FULL original suffix, including the deleted bytes.
	os, oe, ok = back(delSpan.Start, len(corrected))
	require.True(t, ok)
	require.Equal(t, delSpan.Start, os)
	require.Equal(t, len(text), oe)
}

func TestApplyAndTrack_SpanInsideReplacement_NotOk(t *testing.T) {
	text := "I go to school"
	goSpan := spanOf(t, text, "go")
	corrected, back := applyAndTrack(text, []correction.Suggestion{{Span: goSpan, Replacement: "went"}})
	require.Equal(t, "I went to school", corrected)

	wentSpan := spanOf(t, corrected, "went")
	// "en" (strictly inside "went", touching neither edge) has no original
	// equivalent.
	_, _, ok := back(wentSpan.Start+1, wentSpan.End-1)
	require.False(t, ok)
}

func TestApplyAndTrack_MultiEditCompositionAcrossTwoPasses(t *testing.T) {
	original := "I go to school today"
	goSpan := spanOf(t, original, "go")
	pass1 := []correction.Suggestion{{Span: goSpan, Replacement: "went"}}
	currentText, back1 := applyAndTrack(original, pass1)
	require.Equal(t, "I went to school today", currentText)

	// A pass-2 suggestion decoded against currentText, spanning "today"
	// which shifted 2 bytes to the right because of the "go"->"went"
	// length-changing edit.
	todaySpan := spanOf(t, currentText, "today")
	os, oe, ok := back1(todaySpan.Start, todaySpan.End)
	require.True(t, ok)
	require.Equal(t, "today", original[os:oe],
		"translating a pass-2 span through pass-1's back-translator must land on the correct original substring despite the length-changing earlier edit")
}

func TestApplyAndTrack_ThreePassComposition(t *testing.T) {
	original := "I go to school today"

	// Pass 1: "go" -> "went" (+2 bytes).
	goSpan := spanOf(t, original, "go")
	text2, back1 := applyAndTrack(original, []correction.Suggestion{{Span: goSpan, Replacement: "went"}})
	require.Equal(t, "I went to school today", text2)

	// Pass 2 (decoded against text2): "school" -> "class" (-1 byte).
	schoolSpan := spanOf(t, text2, "school")
	text3, back2 := applyAndTrack(text2, []correction.Suggestion{{Span: schoolSpan, Replacement: "class"}})
	require.Equal(t, "I went to class today", text3)

	// Compose exactly as gector.go's Correct loop does: capture the OLD
	// closure in a local FIRST, then build the new one referencing that
	// local — a closure that referenced the variable being reassigned would
	// recurse into itself.
	backToOriginal := back1
	previousBack := backToOriginal
	thisBack := back2
	backToOriginal = func(s, e int) (int, int, bool) {
		ms, me, ok := thisBack(s, e)
		if !ok {
			return 0, 0, false
		}
		return previousBack(ms, me)
	}

	// Pass 3 (decoded against text3): a suggestion spanning "today".
	todaySpan := spanOf(t, text3, "today")
	os, oe, ok := backToOriginal(todaySpan.Start, todaySpan.End)
	require.True(t, ok)
	require.Equal(t, "today", original[os:oe],
		"pass-3 span must translate through the two-deep composed chain back to the ORIGINAL text's 'today', despite both intervening length-changing edits")
}

func TestMergePasses_OverlapEarlierWinsAndOrdering(t *testing.T) {
	// pass1 is deliberately given out of ascending order to prove mergePasses
	// sorts the OUTPUT (decodeToSuggestions itself always emits ASC already).
	pass1 := []correction.Suggestion{
		{Span: correction.Span{Start: 10, End: 14}, Replacement: "AAAA"},
		{Span: correction.Span{Start: 0, End: 2}, Replacement: "Z"},
	}
	pass2 := []correction.Suggestion{
		{Span: correction.Span{Start: 12, End: 13}, Replacement: "B"}, // overlaps pass1's [10,14)
		{Span: correction.Span{Start: 20, End: 22}, Replacement: "C"}, // no overlap
	}
	merged := mergePasses([][]correction.Suggestion{pass1, pass2})
	require.Len(t, merged, 3)
	require.Equal(t, 0, merged[0].Span.Start)
	require.Equal(t, "Z", merged[0].Replacement)
	require.Equal(t, 10, merged[1].Span.Start)
	require.Equal(t, "AAAA", merged[1].Replacement, "earlier pass's overlapping suggestion must win")
	require.Equal(t, 20, merged[2].Span.Start)
	require.Equal(t, "C", merged[2].Replacement)
}

func TestMergePasses_NoOverlapKeepsAll(t *testing.T) {
	pass1 := []correction.Suggestion{{Span: correction.Span{Start: 0, End: 2}, Replacement: "a"}}
	pass2 := []correction.Suggestion{{Span: correction.Span{Start: 5, End: 7}, Replacement: "b"}}
	pass3 := []correction.Suggestion{{Span: correction.Span{Start: 3, End: 4}, Replacement: "c"}}
	merged := mergePasses([][]correction.Suggestion{pass1, pass2, pass3})
	require.Len(t, merged, 3)
	require.Equal(t, []int{0, 3, 5}, []int{merged[0].Span.Start, merged[1].Span.Start, merged[2].Span.Start})
}

func TestMergePasses_EmptyInput(t *testing.T) {
	require.Empty(t, mergePasses(nil))
	require.Empty(t, mergePasses([][]correction.Suggestion{}))
	require.Empty(t, mergePasses([][]correction.Suggestion{nil, nil}))
}
