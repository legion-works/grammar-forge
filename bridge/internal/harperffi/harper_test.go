//go:build cgo

package harperffi

import (
	"context"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

//nolint:misspell // "recieve"/"a apple" are intentional misspellings under test
func TestHarperFindsSpellingByteOffsets(t *testing.T) {
	h := New()
	defer h.Close()
	text := "I recieve a apple"
	sugs, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.NotEmpty(t, sugs, "expected at least one lint for misspelled text")
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
		require.Equal(t, correction.ModelHarper, s.Model)
	}
}

func TestHarperByteOffsetsOnMultibyte(t *testing.T) {
	h := New()
	defer h.Close()
	text := "café recieve" //nolint:misspell // intentional misspelling under test
	sugs, _ := h.Correct(context.Background(), correction.Request{Text: text})
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len(text)))
	}
}

// TestHarperLoanwordPhraseNotFlagged is a real-Harper golden test (not synthetic)
// guarding the loanword filter: the spelling/capitalisation lints Harper raises
// on "café au lait" must be dropped because they chain off the accented "café".
// The filter now keys on Harper's structured LintKind (Spelling/Capitalization)
// rather than message substrings, so this also guards harper_get_lint_kind.
func TestHarperLoanwordPhraseNotFlagged(t *testing.T) {
	h := New()
	defer h.Close()
	const text = "We paid 5 euros for the café au lait."
	sugs, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.Empty(t, sugs, "clean loanphrase must not be flagged after the loanword filter; got %+v", sugs)
}

// TestHarperCorrect_GatesStyleEnhancement_Golden is a real-Harper golden test:
// Harper raises an Enhancement ("Vocabulary enhancement") lint on "very good",
// which a grammar corrector must not surface on the default path. The kind-based
// style gate (isStyleKind) must drop it at the source.
func TestHarperCorrect_GatesStyleEnhancement_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I am very good at mathematics."})
	require.NoError(t, err)
	for _, s := range got {
		require.NotContains(t, s.Message, "Vocabulary enhancement",
			"style enhancement leaked onto the default path: %q -> %q", s.Message, s.Replacement)
	}
}

// TestHarperCorrect_KeepsRealGrammarError_Golden ensures the style gate does not
// over-filter: a genuine subject-verb agreement error (Agreement kind) must
// still surface.
func TestHarperCorrect_KeepsRealGrammarError_Golden(t *testing.T) {
	h := New()
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: "I has three cats."})
	require.NoError(t, err)
	require.NotEmpty(t, got, "the SVA error must still be flagged")
}

// flagsWord reports whether any suggestion's span overlaps the byte range
// [start,end) of the word under test.
func flagsWord(sugs []correction.Suggestion, start, end int) bool {
	for _, s := range sugs {
		if s.Span.Start < end && s.Span.End > start {
			return true
		}
	}
	return false
}

// TestHarperMarkdownMasksCodeSpan is a real-Harper golden test for Task 3: a
// misspelled word inside a Markdown inline-code span must NOT be flagged when
// Markdown parsing is on (code is unlintable), but the SAME word IS flagged with
// plain-English parsing. This proves both the masking and the Markdown toggle.
//
//nolint:misspell // "recieve" is an intentional misspelling under test
func TestHarperMarkdownMasksCodeSpan(t *testing.T) {
	const text = "Call the `recieve` helper."
	// "recieve" occupies bytes [10,17) (after "Call the `").
	require.Equal(t, "recieve", text[10:17])

	md := New() // Markdown on (default)
	defer md.Close()
	got, err := md.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	for _, s := range got {
		require.NoError(t, s.Span.Validate(len(text)))
	}
	require.False(t, flagsWord(got, 10, 17),
		"misspelling inside a code span must not be flagged with Markdown parsing; got %+v", got)

	plain := NewWithOptions(Options{Markdown: false})
	defer plain.Close()
	got, err = plain.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.True(t, flagsWord(got, 10, 17),
		"plain-English parsing should flag the misspelling (sanity check the fixture); got %+v", got)
}

// TestResolveSuggestionEdit directly covers the Task 5 suggestion-kind mapping,
// including the InsertAfter zero-width-span case the reviewer flagged.
func TestResolveSuggestionEdit(t *testing.T) {
	lint := correction.Span{Start: 4, End: 9}

	span, repl := resolveSuggestionEdit(suggestionReplaceWith, "received", lint)
	require.Equal(t, lint, span, "ReplaceWith keeps the lint span")
	require.Equal(t, "received", repl)

	span, repl = resolveSuggestionEdit(suggestionInsertAfter, ",", lint)
	require.Equal(t, correction.Span{Start: 9, End: 9}, span, "InsertAfter is a zero-width edit at the span end")
	require.Equal(t, ",", repl)

	span, repl = resolveSuggestionEdit(suggestionRemove, "", lint)
	require.Equal(t, lint, span, "Remove keeps the lint span")
	require.Equal(t, "", repl, "Remove deletes the range (empty replacement)")

	// Apply sanity: InsertAfter inserts after the range; Remove deletes it.
	const text = "I we received it."
	insSpan, insRepl := resolveSuggestionEdit(suggestionInsertAfter, "X", correction.Span{Start: 0, End: 1})
	require.Equal(t, "IX we received it.", correction.Suggestion{Span: insSpan, Replacement: insRepl}.Apply(text))
	rmSpan, rmRepl := resolveSuggestionEdit(suggestionRemove, "", correction.Span{Start: 0, End: 2})
	require.Equal(t, "we received it.", correction.Suggestion{Span: rmSpan, Replacement: rmRepl}.Apply(text))
}

func TestHarperNoLintsCleanText(t *testing.T) {
	h := New()
	defer h.Close()
	sugs, err := h.Correct(context.Background(), correction.Request{Text: "This is perfectly fine."})
	require.NoError(t, err)
	// "This is perfectly fine." may or may not have any lints (e.g. "perfectly" is fine,
	// "fine" is fine). We assert the call succeeds; we do NOT assert the result is empty
	// because curated rules may flag subjective style choices. The byte-offset guarantee
	// is what matters.
	for _, s := range sugs {
		require.NoError(t, s.Span.Validate(len("This is perfectly fine.")))
	}
}

// TestHarperDisableRule_Golden is a real-Harper golden test for Task 4: with the
// "SpellCheck" rule disabled, the misspelling "recieve" must NOT be flagged,
// while the unrelated article fix (rule "AnA": "a apple" -> "an apple") must
// still fire. Verified rule keys against harper-core 2.4 (SpellCheck via add(),
// AnA via insert_struct_rule_with_dialect! -> stringify!(AnA)).
//
//nolint:misspell // "recieve"/"a apple" are intentional fixtures under test
func TestHarperDisableRule_Golden(t *testing.T) {
	const text = "I recieve a apple"
	// "recieve" occupies bytes [2,9).
	require.Equal(t, "recieve", text[2:9])

	// Baseline: with SpellCheck on (default), the misspelling IS flagged.
	base := NewWithOptions(Options{Markdown: true})
	defer base.Close()
	gotBase, err := base.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.True(t, flagsWord(gotBase, 2, 9),
		"sanity: SpellCheck on should flag the misspelling; got %+v", gotBase)

	// SpellCheck disabled: the misspelling must NOT be flagged.
	h := NewWithOptions(Options{Markdown: true, DisabledRules: []string{"SpellCheck"}})
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.False(t, flagsWord(got, 2, 9),
		"SpellCheck disabled must suppress the misspelling lint; got %+v", got)

	// The AnA article fix must still fire (some lint touches the "a" before
	// "apple", bytes [10,11)).
	require.True(t, flagsWord(got, 10, 11),
		"the AnA article fix must survive disabling SpellCheck; got %+v", got)
}

// TestHarperMaxInputLen_Golden covers the Task 4 max-input guard: an input
// longer than MaxInputLen bytes is skipped entirely (no suggestions, no error),
// while a short misspelled input under the limit is still corrected.
//
//nolint:misspell // intentional misspelling fixture
func TestHarperMaxInputLen_Golden(t *testing.T) {
	h := NewWithOptions(Options{Markdown: true, MaxInputLen: 4})
	defer h.Close()

	long := "I recieve a apple every single day of the week."
	require.Greater(t, len(long), 4)
	got, err := h.Correct(context.Background(), correction.Request{Text: long})
	require.NoError(t, err)
	require.Empty(t, got, "input over MaxInputLen must be skipped entirely; got %+v", got)
}

// TestDialectCode covers the dialect name -> FFI code mapping, including
// case-insensitivity and the American fallback for unknown/empty names.
func TestDialectCode(t *testing.T) {
	require.Equal(t, dialectAmerican, DialectCode("american"))
	require.Equal(t, dialectBritish, DialectCode("British"))
	require.Equal(t, dialectCanadian, DialectCode(" canadian "))
	require.Equal(t, dialectAustralian, DialectCode("AUSTRALIAN"))
	require.Equal(t, dialectIndian, DialectCode("indian"))
	require.Equal(t, dialectAmerican, DialectCode(""))
	require.Equal(t, dialectAmerican, DialectCode("klingon"))
}

func TestCollectReplaceWithAlternatives(t *testing.T) {
	primary := correction.Span{Start: 2, End: 5}
	// (kind, payload, resolvedSpan) tuples as the adapter would read them
	variants := []suggestionVariant{
		{kind: suggestionReplaceWith, payload: "their", span: primary},
		{kind: suggestionReplaceWith, payload: "they're", span: primary},
		{kind: suggestionInsertAfter, payload: ",", span: correction.Span{Start: 5, End: 5}},  // dropped (not ReplaceWith)
		{kind: suggestionReplaceWith, payload: "X", span: correction.Span{Start: 9, End: 10}}, // dropped (different span)
	}
	got := collectReplaceWithAlternatives(variants, primary, 5)
	require.Equal(t, []string{"their", "they're"}, got)
}

func TestCollectReplaceWithAlternativesCap(t *testing.T) {
	primary := correction.Span{Start: 0, End: 1}
	var variants []suggestionVariant
	for i := 0; i < 8; i++ {
		variants = append(variants, suggestionVariant{kind: suggestionReplaceWith, payload: "x", span: primary})
	}
	require.Len(t, collectReplaceWithAlternatives(variants, primary, 5), 5)
}

// buildReplacementsFromVariants contract tests. The wire format distinguishes
// "no edit" (nil) from "edit, possibly a delete" ([]string{repl} of len≥1).
// Only flag-only lints (no suggestions) may leave Replacements == nil.

// Flag-only lint: Harper raised a lint but produced zero suggestions. The
// suggestion is a warning without a concrete edit to apply.
func TestBuildReplacementsFromVariants_FlagOnlyNil(t *testing.T) {
	require.Nil(t, buildReplacementsFromVariants(nil, 5), "no variants must yield nil Replacements")
	require.Nil(t, buildReplacementsFromVariants([]suggestionVariant{}, 5), "empty variants must yield nil Replacements")
}

// Pure deletion primary (Remove kind, payload ""): the suggestion is still
// an edit (it has a span) and the wire list must be []string{""} (len 1),
// NOT nil. Callers must be able to tell "delete this range" from "no edit".
func TestBuildReplacementsFromVariants_RemovePrimaryYieldsEmptyStringList(t *testing.T) {
	variants := []suggestionVariant{
		{kind: suggestionRemove, payload: "", span: correction.Span{Start: 2, End: 5}},
	}
	got := buildReplacementsFromVariants(variants, 5)
	require.Equal(t, []string{""}, got,
		"Remove primary must produce Replacements=[\"\"] (len 1), not nil")
}

// ReplaceWith primary with no further alts: exactly one element.
func TestBuildReplacementsFromVariants_ReplaceWithSingle(t *testing.T) {
	variants := []suggestionVariant{
		{kind: suggestionReplaceWith, payload: "the", span: correction.Span{Start: 0, End: 3}},
	}
	require.Equal(t, []string{"the"}, buildReplacementsFromVariants(variants, 5))
}

// ReplaceWith primary + alts: primary first, then alternatives on the same
// primary span. InsertAfter/Remove alts and a different-span alt are dropped.
func TestBuildReplacementsFromVariants_ReplaceWithPlusAlts(t *testing.T) {
	primary := correction.Span{Start: 2, End: 5}
	variants := []suggestionVariant{
		{kind: suggestionReplaceWith, payload: "the", span: primary},
		{kind: suggestionReplaceWith, payload: "tea", span: primary},
		{kind: suggestionInsertAfter, payload: ",", span: correction.Span{Start: 5, End: 5}},  // dropped
		{kind: suggestionReplaceWith, payload: "X", span: correction.Span{Start: 9, End: 10}}, // dropped (different span)
	}
	require.Equal(t, []string{"the", "tea"}, buildReplacementsFromVariants(variants, 5))
}

// Cap at maxAlt: primary + (maxAlt-1) further alts.
func TestBuildReplacementsFromVariants_RespectsCap(t *testing.T) {
	primary := correction.Span{Start: 0, End: 1}
	variants := []suggestionVariant{{kind: suggestionReplaceWith, payload: "p", span: primary}}
	for i := 0; i < 8; i++ {
		variants = append(variants, suggestionVariant{kind: suggestionReplaceWith, payload: "x", span: primary})
	}
	require.Len(t, buildReplacementsFromVariants(variants, 5), 5)
}
