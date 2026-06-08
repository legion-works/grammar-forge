//go:build cgo

package harperffi

import (
	"strings"

	"github.com/grammarforge/bridge/internal/correction"
)

// harperMsgVocabEnhancement marks Harper's style/word-choice "Vocabulary
// enhancement" lints (e.g. "very good" -> "excellent"). These rewrite an
// already-correct phrase for style — a false positive for a grammar CORRECTOR
// on the default path. Matched as a substring (the harper-c FFI exposes only
// the message, not a LintKind). Verified against real harper-core, 2026-06-08.
const harperMsgVocabEnhancement = "Vocabulary enhancement"

// isStyleEnhancement reports whether a Harper lint message is a style/word-choice
// enhancement (gated off the default grammar path; a future picky-mode may
// resurface these — SPEC §6).
func isStyleEnhancement(message string) bool {
	return strings.Contains(message, harperMsgVocabEnhancement)
}

// filterStyleSuggestions drops Harper style/word-choice ("Vocabulary
// enhancement") suggestions, keeping every grammatical/spelling/punctuation
// lint. A grammar corrector must not rewrite a valid word for style by default.
func filterStyleSuggestions(sugs []correction.Suggestion) []correction.Suggestion {
	if len(sugs) == 0 {
		return sugs
	}
	out := make([]correction.Suggestion, 0, len(sugs))
	for _, s := range sugs {
		if isStyleEnhancement(s.Message) {
			continue
		}
		out = append(out, s)
	}
	return out
}
