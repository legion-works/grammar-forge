package correction

import (
	"strings"
	"unicode"

	"github.com/sergi/go-diff/diffmatchpatch"
)

// diffToSuggestions computes a character diff between original and corrected and
// returns minimal edit Suggestions with BYTE-offset spans into original. A
// delete-then-insert pair becomes one replacement; a lone insert is a zero-width
// span; a lone delete is a deletion (empty replacement). Suggestions are ordered
// by ascending span start (apply them last-to-first to keep offsets valid).
// The grammar path: every suggestion gets Category == "" (CategoryGrammar) so
// JSON output is unchanged.
func diffToSuggestions(original, corrected string) []Suggestion {
	return diffToSuggestionsCategory(original, corrected, CategoryGrammar)
}

// diffToSuggestionsCategory is the workhorse used by both the grammar path and
// the picky-mode style pass. category tags every produced Suggestion (see
// CategoryGrammar, CategoryStyle). Model is always ModelLLM because the diff
// is always computed against the LLM's corrected output — whether that output
// is a grammar correction or a style restyle is a property of the LLM call, not
// of the diff itself.
func diffToSuggestionsCategory(original, corrected string, category string) []Suggestion {
	dmp := diffmatchpatch.New()
	diffs := dmp.DiffMain(original, corrected, false)
	dmp.DiffCleanupSemantic(diffs)

	var out []Suggestion
	pos := 0 // byte offset into original
	for i := 0; i < len(diffs); i++ {
		d := diffs[i]
		switch d.Type {
		case diffmatchpatch.DiffEqual:
			pos += len(d.Text)
		case diffmatchpatch.DiffDelete:
			start := pos
			pos += len(d.Text)
			repl := ""
			if i+1 < len(diffs) && diffs[i+1].Type == diffmatchpatch.DiffInsert {
				repl = diffs[i+1].Text
				i++ // consume the paired insert
			}
			// Every diff suggestion is an edit (a flag-only suggestion never
			// appears here — we're diffing original vs corrected). A pure
			// deletion has repl=="" but still a span, so Replacements must be
			// []string{""} (len 1) to distinguish "delete this range" from
			// "no edit" (Replacements==nil, only possible for flag-only lints).
			out = append(out, Suggestion{
				Span: Span{Start: start, End: start + len(d.Text)}, Replacement: repl,
				Replacements: []string{repl}, Model: ModelLLM, Category: category,
			})
		case diffmatchpatch.DiffInsert:
			out = append(out, Suggestion{
				Span: Span{Start: pos, End: pos}, Replacement: d.Text,
				Replacements: []string{d.Text}, Model: ModelLLM, Category: category,
			})
		}
	}
	// Cancel no-ops BEFORE coalescing (so a no-op fragment doesn't widen a
	// merged span) and again AFTER (a merge of complementary edits — e.g. a
	// transposition the LLM made and unmade — can net out to identity).
	out = cancelNoOpSuggestions(original, out)
	out = coalesceSameWordEdits(original, out)
	return cancelNoOpSuggestions(original, out)
}

// coalesceSameWordEdits merges consecutive suggestions whose spans have no
// whitespace between them (i.e. fragments of the SAME whitespace-delimited
// word) into one suggestion spanning the union, with the constituent edits
// netted into a single replacement. The char-level diff can split one
// logical word fix into several minimal edits (verified live 2026-06-10:
// "tset"->"test" became [delete "s"] + [insert "s"], so the client's
// per-item word diff showed the nonsense "tset -> tet", a single Apply
// produced a half-edit, and accept/reject signals attributed to half a
// word). Input must be ordered by ascending span start (diffToSuggestions'
// output contract). Applying the coalesced set yields byte-identical text
// to applying the input set. Suggestions with invalid or out-of-order spans
// are never merged (Span.Validate is the source of truth; the rest of the
// pipeline is robust to them).
func coalesceSameWordEdits(original string, in []Suggestion) []Suggestion {
	if len(in) < 2 {
		return in
	}
	out := make([]Suggestion, 0, len(in))
	cur := in[0]
	for _, next := range in[1:] {
		mergeable := cur.Span.Validate(len(original)) == nil &&
			next.Span.Validate(len(original)) == nil &&
			next.Span.Start >= cur.Span.End &&
			!containsWhitespace(original[cur.Span.End:next.Span.Start])
		if mergeable {
			// Ordered, gap-separated edits net into: cur's replacement +
			// the untouched gap text + next's replacement.
			merged := cur.Replacement + original[cur.Span.End:next.Span.Start] + next.Replacement
			cur = Suggestion{
				Span:         Span{Start: cur.Span.Start, End: next.Span.End},
				Replacement:  merged,
				Replacements: []string{merged},
				Model:        cur.Model,
				Category:     cur.Category,
			}
			continue
		}
		out = append(out, cur)
		cur = next
	}
	return append(out, cur)
}

// containsWhitespace reports whether s contains any Unicode whitespace rune.
func containsWhitespace(s string) bool {
	return strings.IndexFunc(s, unicode.IsSpace) >= 0
}

// cancelNoOpSuggestions drops suggestions that, applied to original, change
// nothing (replacement byte-identical to the spanned original text, including
// an empty span with an empty replacement). It is conservative: it removes ONLY
// provable no-ops and never alters a real edit. original is the text the spans
// index into (byte offsets). It deliberately does NOT try to cancel
// insert/delete pairs — a positional heuristic cannot distinguish LLM churn
// from a legitimate text move, and doing so would drop real corrections.
func cancelNoOpSuggestions(original string, in []Suggestion) []Suggestion {
	if len(in) == 0 {
		return in
	}
	kept := make([]Suggestion, 0, len(in))
	for _, s := range in {
		if s.Span.Validate(len(original)) != nil {
			kept = append(kept, s) // leave invalid spans for the harness to flag
			continue
		}
		if original[s.Span.Start:s.Span.End] == s.Replacement {
			continue // no-op: applying changes nothing
		}
		kept = append(kept, s)
	}
	return kept
}
