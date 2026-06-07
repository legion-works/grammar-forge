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
// space (the tokenizer emits "ĠMe" [0,2) — Ġ present, but Start=0 with no real
// preceding space). The old decoder keyed on the Ġ leader and prepended a space,
// producing " me and ..." with a corrupt leading space.
func TestDecodeSentenceInitialNoSpuriousLeadingSpace(t *testing.T) {
	const text = "Me and him went to the game."
	ents := []pipelines.Entity{
		ent("\u0120Me", "$TRANSFORM_CASE_LOWER", 0, 2, 0.882),
		ent("\u0120and", "$KEEP", 2, 6, 0.874),
		ent("\u0120him", "$KEEP", 6, 10, 0.589),
		ent("\u0120went", "$KEEP", 10, 15, 0.956),
		ent("\u0120to", "$KEEP", 15, 18, 0.985),
		ent("\u0120the", "$KEEP", 18, 22, 0.994),
		ent("\u0120game", "$KEEP", 22, 27, 0.992),
		ent(".", "$KEEP", 27, 28, 0.997),
	}
	sugs, err := decodeToSuggestions(text, ents, VerbVocab{})
	require.NoError(t, err)
	require.Len(t, sugs, 1, "only the CASE_LOWER on 'Me' should produce a suggestion")
	require.Equal(t, correction.Span{Start: 0, End: 2}, sugs[0].Span)
	require.Equal(t, "me", sugs[0].Replacement, "no spurious leading space; faithful lowercasing")
	require.Equal(t, "me and him went to the game.", applyAll(text, sugs))
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
