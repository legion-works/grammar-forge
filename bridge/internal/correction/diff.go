package correction

import "github.com/sergi/go-diff/diffmatchpatch"

// diffToSuggestions computes a character diff between original and corrected and
// returns minimal edit Suggestions with BYTE-offset spans into original. A
// delete-then-insert pair becomes one replacement; a lone insert is a zero-width
// span; a lone delete is a deletion (empty replacement). Suggestions are ordered
// by ascending span start (apply them last-to-first to keep offsets valid).
func diffToSuggestions(original, corrected string) []Suggestion {
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
			})
		case diffmatchpatch.DiffInsert:
			out = append(out, Suggestion{
				Span: Span{Start: pos, End: pos}, Replacement: d.Text, Model: ModelLLM,
			})
		}
	}
	return out
}
