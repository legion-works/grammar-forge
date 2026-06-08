package correction

import "github.com/sergi/go-diff/diffmatchpatch"

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
			out = append(out, Suggestion{
				Span: Span{Start: start, End: start + len(d.Text)}, Replacement: repl, Model: ModelLLM,
				Category: category,
			})
		case diffmatchpatch.DiffInsert:
			out = append(out, Suggestion{
				Span: Span{Start: pos, End: pos}, Replacement: d.Text, Model: ModelLLM,
				Category: category,
			})
		}
	}
	return out
}
