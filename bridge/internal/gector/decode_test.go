//go:build cgo && ORT

package gector

import (
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/knights-analytics/hugot/pipelines"
	"github.com/stretchr/testify/require"
)

// ent is a terse constructor for a synthetic per-subword GECToR entity. The
// Word carries the Ġ (U+0120) leader exactly as the hugot tokenizer emits it;
// Start/End are BYTE offsets into the original text (the tokenizer includes the
// leading space in a leadered, non-sentence-initial token's span).
func ent(word, tag string, start, end uint, score float32) pipelines.Entity {
	return pipelines.Entity{Word: word, Entity: tag, Start: start, End: end, Score: score}
}

// applyAll applies suggestions last-to-first (matching the bridge contract) so
// earlier byte offsets stay valid as later spans are replaced.
func applyAll(text string, sugs []correction.Suggestion) string {
	out := text
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	return out
}

// Bug #1 symptom 1: a sentence-initial edit must NOT get a spurious leading
// space (tokenizer emits "ĠTeh" [0,3) — Ġ present, Start=0, no real preceding
// space). Uses a REPLACE because sentence-initial CASE_LOWER is now suppressed.
func TestDecodeSentenceInitialNoSpuriousLeadingSpace(t *testing.T) {
	const text = "Teh cat sat."
	ents := []pipelines.Entity{
		ent("\u0120Teh", "$REPLACE_The", 0, 3, 0.95),
		ent("\u0120cat", "$KEEP", 3, 7, 0.9),
		ent("\u0120sat", "$KEEP", 7, 11, 0.9),
		ent(".", "$KEEP", 11, 12, 0.9),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, correction.Span{Start: 0, End: 3}, sugs[0].Span)
	require.Equal(t, "The", sugs[0].Replacement, "no spurious leading space at position 0")
	require.Equal(t, "The cat sat.", applyAll(text, sugs))
}

// Bug #1 symptom 2: $APPEND must insert a separating space — "listen" +
// $APPEND_to is "listen to", not "listento".
func TestDecodeAppendInsertsSpace(t *testing.T) {
	const text = "Please listen me carefully."
	ents := []pipelines.Entity{
		ent("\u0120Please", "$KEEP", 0, 6, 0.979),
		ent("\u0120listen", "$APPEND_to", 6, 13, 0.943),
		ent("\u0120me", "$KEEP", 13, 16, 0.966),
		ent("\u0120carefully", "$KEEP", 16, 26, 0.993),
		ent(".", "$KEEP", 26, 27, 0.998),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, correction.Span{Start: 7, End: 13}, sugs[0].Span, "span covers 'listen', not the leading space")
	require.Equal(t, "listen to", sugs[0].Replacement)
	require.Equal(t, "Please listen to me carefully.", applyAll(text, sugs))
}

// Bug #1 (review follow-up): $APPEND of punctuation/contractions must NOT insert
// a space — only word appends do. The GECToR label set includes $APPEND_.,
// $APPEND_'s, $APPEND_n't, etc.
func TestDecodeAppendPunctuationAndContractionsNoSpace(t *testing.T) {
	cases := []struct {
		name, text, word, tag string
		start, end            uint
		wantRepl, want        string
	}{
		{"word_to", "listen", "listen", "$APPEND_to", 0, 6, "listen to", "listen to"},
		{"contraction_s", "it", "it", "$APPEND_'s", 0, 2, "it's", "it's"},
		{"contraction_nt", "ca", "ca", "$APPEND_n't", 0, 2, "can't", "can't"},
		{"period", "word", "word", "$APPEND_.", 0, 4, "word.", "word."},
		{"comma", "word", "word", "$APPEND_,", 0, 4, "word,", "word,"},
		// mid-sentence: " they" [4,9) normalises to [5,9); contraction attaches.
		{"mid_contraction", "I am they here", "they", "$APPEND_'re", 4, 9, "they're", "I am they're here"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := ent("\u0120"+c.word, c.tag, c.start, c.end, 0.95)
			sugs, err := decodeToSuggestions(c.text, []pipelines.Entity{e}, VerbVocab{})
			require.NoError(t, err)
			require.Len(t, sugs, 1)
			require.Equal(t, c.wantRepl, sugs[0].Replacement)
			require.Equal(t, c.want, applyAll(c.text, sugs))
		})
	}
}

// Bug #1 symptom 3: trailing punctuation is a SEPARATE entity ("." [19,20)
// $KEEP) without a Ġ leader. It must not be merged into the preceding
// $REPLACE'd word, or the period is dropped ("he." -> "him").
func TestDecodeReplacePreservesTrailingPunctuation(t *testing.T) {
	const text = "Give the book to he."
	ents := []pipelines.Entity{
		ent("\u0120Give", "$KEEP", 0, 4, 0.578),
		ent("\u0120the", "$KEEP", 4, 8, 0.984),
		ent("\u0120book", "$KEEP", 8, 13, 0.994),
		ent("\u0120to", "$KEEP", 13, 16, 0.965),
		ent("\u0120he", "$REPLACE_him", 16, 19, 0.948),
		ent(".", "$KEEP", 19, 20, 0.971),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1, "only 'he'->'him'; the period keeps its own $KEEP tag")
	require.Equal(t, correction.Span{Start: 17, End: 19}, sugs[0].Span)
	require.Equal(t, "him", sugs[0].Replacement)
	require.Equal(t, "Give the book to him.", applyAll(text, sugs))
}

// Bug #1 regression: a mid-sentence verb-form transform must still produce a
// clean span over the word only (the leading-space normalisation replaces the
// old prepend-a-space hack). "Ġseen" [1,6) covers " seen"; the span normalises
// to [2,6) and the replacement carries no leading space.
func TestDecodeMidSentenceTransformCleanSpan(t *testing.T) {
	const text = "I seen it yesterday."
	vocab := VerbVocab{"seen": {"VBN_VBD": "saw"}}
	ents := []pipelines.Entity{
		ent("\u0120I", "$KEEP", 0, 1, 0.992),
		ent("\u0120seen", "$TRANSFORM_VERB_VBN_VBD", 1, 6, 0.907),
		ent("\u0120it", "$KEEP", 6, 9, 0.970),
		ent("\u0120yesterday", "$KEEP", 9, 19, 0.996),
		ent(".", "$KEEP", 19, 20, 0.995),
	}
	sugs, err := decodeToSuggestions(text, ents, vocab)
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, correction.Span{Start: 2, End: 6}, sugs[0].Span)
	require.Equal(t, "saw", sugs[0].Replacement)
	require.Equal(t, "I saw it yesterday.", applyAll(text, sugs))
}

// Bug #1 regression: a $DELETE must keep the leading space inside the span so
// deleting a word does not leave a double space. (Replacing edits drop the
// leading space; deletions keep it.)
func TestDecodeDeleteKeepsLeadingSpaceNoDoubleSpace(t *testing.T) {
	const text = "I really really want"
	ents := []pipelines.Entity{
		ent("\u0120I", "$KEEP", 0, 1, 0.99),
		ent("\u0120really", "$KEEP", 1, 8, 0.99),
		ent("\u0120really", "$DELETE", 8, 15, 0.99),
		ent("\u0120want", "$KEEP", 15, 20, 0.99),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, correction.Span{Start: 8, End: 15}, sugs[0].Span, "delete span keeps the leading space")
	require.Equal(t, "", sugs[0].Replacement)
	require.Equal(t, "I really want", applyAll(text, sugs))
}

// All-$KEEP input produces no suggestions.
func TestDecodeAllKeepNoSuggestions(t *testing.T) {
	const text = "Her and I are good friends."
	ents := []pipelines.Entity{
		ent("\u0120Her", "$KEEP", 0, 3, 0.830),
		ent("\u0120and", "$KEEP", 3, 7, 0.887),
		ent("\u0120I", "$KEEP", 7, 9, 0.980),
		ent("\u0120are", "$KEEP", 9, 13, 0.995),
		ent("\u0120good", "$KEEP", 13, 18, 0.999),
		ent("\u0120friends", "$KEEP", 18, 26, 0.997),
		ent(".", "$KEEP", 26, 27, 0.998),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Empty(t, sugs)
}

// Multi-subword (BPE) words must still merge their alphanumeric continuations
// and apply the first subword's tag to the whole word — only standalone
// punctuation is split off.
func TestDecodeMergesAlphanumericSubwords(t *testing.T) {
	// "intelligant" tokenised as "Ġintelli" + "gant" (continuation, no leader),
	// REPLACE -> "intelligent". The continuation must merge; the trailing "."
	// is a separate token and must be preserved.
	// bytes: v0 e1 r2 y3 _4 i5 n6 t7 e8 l9 l10 i11 g12 a13 n14 t15 .16  (len 17)
	const text = "very intelligant."
	ents := []pipelines.Entity{
		ent("\u0120very", "$KEEP", 0, 4, 0.99),
		ent("\u0120intelli", "$REPLACE_intelligent", 4, 12, 0.95),
		ent("gant", "$KEEP", 12, 16, 0.95),
		ent(".", "$KEEP", 16, 17, 0.99),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, correction.Span{Start: 5, End: 16}, sugs[0].Span, "span covers the whole merged word 'intelligant'")
	require.Equal(t, "intelligent", sugs[0].Replacement)
	require.Equal(t, "very intelligent.", applyAll(text, sugs))
}

// Lever #1a: sentence-initial $TRANSFORM_CASE_LOWER must be suppressed.
func TestDecodeSuppressesSentenceInitialCaseLower(t *testing.T) {
	const text = "Me and him went."
	ents := []pipelines.Entity{
		ent("\u0120Me", "$TRANSFORM_CASE_LOWER", 0, 2, 0.882),
		ent("\u0120and", "$KEEP", 2, 6, 0.9),
		ent("\u0120him", "$KEEP", 6, 10, 0.9),
		ent("\u0120went", "$KEEP", 10, 15, 0.9),
		ent(".", "$KEEP", 15, 16, 0.9),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Empty(t, sugs, "sentence-initial CASE_LOWER must be suppressed")
}

// Lever #1a: a wrongly-capitalised MID-sentence word must still be lowercased.
func TestDecodeKeepsMidSentenceCaseLower(t *testing.T) {
	const text = "the Cat sat"
	ents := []pipelines.Entity{
		ent("\u0120the", "$KEEP", 0, 3, 0.9),
		ent("\u0120Cat", "$TRANSFORM_CASE_LOWER", 3, 7, 0.9),
		ent("\u0120sat", "$KEEP", 7, 11, 0.9),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1)
	require.Equal(t, "cat", sugs[0].Replacement)
	require.Equal(t, "the cat sat", applyAll(text, sugs))
}

// Lever #1a: CASE_LOWER on the first word AFTER a sentence end is also suppressed.
// Uses "Then" (capitalised) so the test is EFFECTIVE — without the guard the
// decoder would emit "Then"->"then"; the guard must suppress it.
func TestDecodeSuppressesCaseLowerAfterSentenceEnd(t *testing.T) {
	const text = "Go now. Then rest."
	ents := []pipelines.Entity{
		ent("\u0120Go", "$KEEP", 0, 2, 0.9),
		ent("\u0120now", "$KEEP", 2, 6, 0.9),
		ent(".", "$KEEP", 6, 7, 0.9),
		ent("\u0120Then", "$TRANSFORM_CASE_LOWER", 7, 12, 0.9),
		ent("\u0120rest", "$KEEP", 12, 17, 0.9),
		ent(".", "$KEEP", 17, 18, 0.9),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Empty(t, sugs, "CASE_LOWER after a sentence end must be suppressed")
}
