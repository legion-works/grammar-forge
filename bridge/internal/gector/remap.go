// Package gector runs the GECToR ONNX model in-process via hugot and implements
// correction.Corrector (see gector.go, built with -tags ORT). This file
// (remap.go) holds the pure byte-offset remapping math behind the
// GF_GECTOR_PASSES multi-pass feature; it has no cgo/ORT dependency and is
// compiled — and tested — in every build.
package gector

import (
	"sort"
	"strings"

	"github.com/grammarforge/bridge/internal/correction"
)

// textSegment is one contiguous run of the text produced by applyAndTrack:
// either an UNCHANGED copy of a slice of the input text (isReplacement=false;
// corrEnd-corrStart == origEnd-origStart, a constant-offset identity mapping)
// or a REPLACEMENT of an input byte span with a suggestion's Replacement text
// (isReplacement=true; either side may be zero-width — an insertion has
// origStart==origEnd, a deletion has corrStart==corrEnd).
type textSegment struct {
	origStart, origEnd int
	corrStart, corrEnd int
	isReplacement      bool
}

// applyAndTrack applies suggestions (byte spans into text, sorted ASC,
// non-overlapping — decodeToSuggestions emits them in that order already) and
// returns the corrected text plus a translator that maps a byte span in the
// CORRECTED text back to original-text coordinates.
//
// The corrected text is built as an alternating sequence of UNCHANGED
// segments (verbatim slices of text between edits) and REPLACEMENT segments
// (one per suggestion). The translator resolves a single corrected-text byte
// POSITION to an original-text position by finding which segment it falls
// in:
//   - a position at the LEFT EDGE of a replacement segment (including a
//     zero-width one, i.e. a deletion) resolves to that segment's original
//     start — this is what "touching a replacement" means, and it is exact;
//   - a position anywhere inside (or at the edges of) an unchanged segment
//     resolves via that segment's constant offset — also exact;
//   - a position strictly inside the INTERIOR of a non-zero-width
//     replacement (neither edge) has no single-byte original equivalent;
//   - the very end of the corrected text resolves to the end of the
//     original text.
//
// A requested [start,end) span translates (ok=true) only when BOTH edges
// resolve. A corrected-text span that lies strictly inside a replaced region
// therefore reports ok=false; the caller drops that suggestion and counts it.
func applyAndTrack(text string, sugs []correction.Suggestion) (string, func(start, end int) (int, int, bool)) {
	segs := make([]textSegment, 0, len(sugs)*2+1)
	var b strings.Builder
	origPos := 0
	corrPos := 0
	for _, s := range sugs {
		start, end := s.Span.Start, s.Span.End
		if start > origPos {
			b.WriteString(text[origPos:start])
			segs = append(segs, textSegment{
				origStart: origPos, origEnd: start,
				corrStart: corrPos, corrEnd: corrPos + (start - origPos),
			})
			corrPos += start - origPos
		}
		b.WriteString(s.Replacement)
		segs = append(segs, textSegment{
			origStart: start, origEnd: end,
			corrStart: corrPos, corrEnd: corrPos + len(s.Replacement),
			isReplacement: true,
		})
		corrPos += len(s.Replacement)
		origPos = end
	}
	if origPos < len(text) {
		b.WriteString(text[origPos:])
		segs = append(segs, textSegment{
			origStart: origPos, origEnd: len(text),
			corrStart: corrPos, corrEnd: corrPos + (len(text) - origPos),
		})
	}
	corrected := b.String()
	origLen := len(text)
	correctedLen := len(corrected)

	resolve := func(pos int) (int, bool) {
		if pos == correctedLen {
			if len(segs) == 0 {
				return origLen, true
			}
			return segs[len(segs)-1].origEnd, true
		}
		// Priority 1: a position exactly at the left edge of a replacement
		// segment (including zero-width deletions) always resolves exactly,
		// even when it also coincides with an adjacent unchanged segment's
		// boundary — "touching" a replacement is defined by this edge.
		for _, seg := range segs {
			if seg.isReplacement && pos == seg.corrStart {
				return seg.origStart, true
			}
		}
		// Priority 2: a position inside (or at the edges of) an unchanged
		// segment resolves by constant offset.
		for _, seg := range segs {
			if !seg.isReplacement && pos >= seg.corrStart && pos < seg.corrEnd {
				return seg.origStart + (pos - seg.corrStart), true
			}
		}
		// Otherwise pos is strictly inside the interior of a non-zero-width
		// replacement: no original equivalent.
		return 0, false
	}

	back := func(start, end int) (int, int, bool) {
		os, ok := resolve(start)
		if !ok {
			return 0, 0, false
		}
		oe, ok := resolve(end)
		if !ok {
			return 0, 0, false
		}
		return os, oe, true
	}
	return corrected, back
}

// mergePasses unions pass-1 suggestions with remapped later-pass
// suggestions. Overlapping spans keep the suggestion from the EARLIER pass
// (lower index in passes) — the first pass saw the user's real, unmodified
// text. The result is sorted by Span.Start ascending.
func mergePasses(passes [][]correction.Suggestion) []correction.Suggestion {
	var out []correction.Suggestion
	for _, pass := range passes {
		for _, s := range pass {
			if overlapsAny(out, s.Span) {
				continue
			}
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Span.Start < out[j].Span.Start })
	return out
}

// overlapsAny reports whether span overlaps any suggestion already in
// existing. Half-open byte ranges: two spans overlap iff each starts before
// the other ends. Two spans that merely touch at a shared boundary (e.g. a
// zero-width insertion sitting exactly at another span's edge) do not count
// as overlapping.
func overlapsAny(existing []correction.Suggestion, span correction.Span) bool {
	for _, e := range existing {
		if span.Start < e.Span.End && e.Span.Start < span.End {
			return true
		}
	}
	return false
}
