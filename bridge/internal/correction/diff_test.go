package correction

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDiffNoChange(t *testing.T) {
	if got := diffToSuggestions("all good", "all good"); len(got) != 0 {
		t.Fatalf("expected 0 suggestions, got %d", len(got))
	}
}

func TestDiffSingleReplacement(t *testing.T) {
	sugs := diffToSuggestions("I has a cat", "I have a cat")
	if len(sugs) != 1 {
		t.Fatalf("want 1 suggestion, got %d: %+v", len(sugs), sugs)
	}
	s := sugs[0]
	if s.Model != ModelLLM {
		t.Errorf("model = %q", s.Model)
	}
	// Applying the suggestion to the original must yield the corrected text.
	if got := s.Apply("I has a cat"); got != "I have a cat" {
		t.Errorf("Apply = %q", got)
	}
}

// TestDiffPopulatesReplacements locks the WS-A contract: EVERY diff edit
// (including pure deletions where Replacement="") must carry
// Replacements == []string{Replacement} so the wire format consistently
// advertises the candidate list. Only a flag-only lint (no edit at all)
// is allowed to leave Replacements == nil — and diffToSuggestions never
// produces a flag-only suggestion (it diffs original vs corrected, so any
// produced suggestion is by construction an edit).
func TestDiffPopulatesReplacements(t *testing.T) {
	// Mixed edit: a replacement and a zero-width insertion. //nolint:misspell // intentional fixture
	sugs := diffToSuggestions("teh cat", "the cat") //nolint:misspell // intentional misspelling fixture
	require.NotEmpty(t, sugs)
	for _, s := range sugs {
		require.NotNil(t, s.Replacements,
			"every diff suggestion is an edit; Replacements must be non-nil")
		require.Len(t, s.Replacements, 1,
			"diff always emits exactly one primary replacement")
		require.Equal(t, s.Replacement, s.Replacements[0],
			"Replacements[0] must equal Replacement")
	}
}

// TestDiffDeletionEditCarriesEmptyReplacements locks the deletion case
// specifically: a pure deletion ("the the cat" -> "the cat") is still an
// edit (it has a span) so Replacements must be []string{""} (len 1), NOT
// nil. The wire format distinguishes "no edit" (nil) from "delete this
// range" ([]string{""}).
func TestDiffDeletionEditCarriesEmptyReplacements(t *testing.T) {
	sugs := diffToSuggestions("the the cat", "the cat")
	require.NotEmpty(t, sugs)
	var del *Suggestion
	for i := range sugs {
		if sugs[i].Replacement == "" && sugs[i].Span.End > sugs[i].Span.Start {
			del = &sugs[i]
			break
		}
	}
	require.NotNil(t, del, "expected a deletion suggestion; got %+v", sugs)
	require.Equal(t, []string{""}, del.Replacements,
		"a deletion (Replacement=\"\") must still carry Replacements=[\"\"] (len 1), not nil")
}

func TestDiffSuggestionsAreApplicableInReverse(t *testing.T) {
	original := "She dont liks it"
	corrected := "She doesn't like it"
	sugs := diffToSuggestions(original, corrected)
	if len(sugs) == 0 {
		t.Fatal("expected suggestions")
	}
	// Apply from last span to first so earlier offsets stay valid.
	out := original
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	if out != corrected {
		t.Errorf("reverse-apply = %q, want %q", out, corrected)
	}
}

func TestDiffLoneInsertionIsZeroWidth(t *testing.T) {
	sugs := diffToSuggestions("acat", "a cat")
	if len(sugs) == 0 {
		t.Fatal("expected a suggestion for lone insertion")
	}
	// Find the insertion: zero-width span with non-empty replacement.
	var ins *Suggestion
	for i := range sugs {
		if sugs[i].Span.Start == sugs[i].Span.End && sugs[i].Replacement != "" {
			ins = &sugs[i]
			break
		}
	}
	if ins == nil {
		t.Fatalf("no zero-width insertion found: %+v", sugs)
	}
	if got := ins.Apply("acat"); got != "a cat" {
		t.Errorf("apply insertion = %q, want %q", got, "a cat")
	}
}

func TestDiffLoneDeletionHasEmptyReplacement(t *testing.T) {
	sugs := diffToSuggestions("a cat", "acat")
	if len(sugs) == 0 {
		t.Fatal("expected a suggestion for lone deletion")
	}
	// Find the deletion: non-empty span with empty replacement.
	var del *Suggestion
	for i := range sugs {
		if sugs[i].Span.End > sugs[i].Span.Start && sugs[i].Replacement == "" {
			del = &sugs[i]
			break
		}
	}
	if del == nil {
		t.Fatalf("no non-empty-span deletion found: %+v", sugs)
	}
	if got := del.Apply("a cat"); got != "acat" {
		t.Errorf("apply deletion = %q, want %q", got, "acat")
	}
}

// diffToSuggestionsCategory tags every produced Suggestion with the given
// category. The grammar path uses CategoryGrammar ("") so JSON output is
// unchanged; picky-mode style pass uses CategoryStyle so clients can
// distinguish style suggestions from grammar ones.
func TestDiffToSuggestionsCategory(t *testing.T) {
	sugs := diffToSuggestionsCategory("I has a cat", "I have a cat", CategoryStyle)
	if len(sugs) != 1 {
		t.Fatalf("want 1 suggestion, got %d: %+v", len(sugs), sugs)
	}
	if sugs[0].Category != CategoryStyle {
		t.Errorf("category = %q, want %q", sugs[0].Category, CategoryStyle)
	}
	if sugs[0].Model != ModelLLM {
		t.Errorf("model = %q, want %q", sugs[0].Model, ModelLLM)
	}
}

// diffToSuggestions is the grammar-path wrapper; it must keep Category empty
// so existing JSON serialisation is unchanged (omitempty drops the field).
func TestDiffToSuggestionsGrammarCategoryEmpty(t *testing.T) {
	sugs := diffToSuggestions("I has a cat", "I have a cat")
	if len(sugs) != 1 {
		t.Fatalf("want 1 suggestion, got %d", len(sugs))
	}
	if sugs[0].Category != "" {
		t.Errorf("grammar category = %q, want empty (omitempty in JSON)", sugs[0].Category)
	}
}

func TestDiffMultibyteByteSpanApplies(t *testing.T) {
	original := "café €5"
	corrected := "café $5"
	start := strings.Index(original, "€")
	if start < 0 {
		t.Fatal("setup: € not found")
	}
	// Sanity: byte offset of the multibyte char in a multibyte string.
	if got := len("café "); got != 6 {
		t.Fatalf("setup: len(\"café \") = %d, want 6", got)
	}
	if got := len("€"); got != 3 {
		t.Fatalf("setup: len(\"€\") = %d, want 3", got)
	}
	sugs := diffToSuggestions(original, corrected)
	if len(sugs) == 0 {
		t.Fatal("expected a suggestion")
	}
	// At least one suggestion must start at the multibyte character's byte offset.
	var s *Suggestion
	for i := range sugs {
		if sugs[i].Span.Start == start {
			s = &sugs[i]
			break
		}
	}
	if s == nil {
		t.Fatalf("no suggestion starts at byte offset %d (€): %+v", start, sugs)
	}
	// The byte span must stay within the multibyte character — End must align
	// on a rune boundary (Start + a multiple of the € char's byte length).
	const euroByteLen = 3
	if (s.Span.End-start)%euroByteLen != 0 || s.Span.End < start {
		t.Errorf("span end %d not on rune boundary from start %d", s.Span.End, start)
	}
	// Applying the entire suggestion set in reverse must yield the corrected text.
	out := original
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	if out != corrected {
		t.Errorf("reverse-apply = %q, want %q", out, corrected)
	}
}

// A suggestion whose replacement equals the spanned original text is a no-op
// and must be dropped.
func TestDiffDropsZeroEffectReplacement(t *testing.T) {
	original := "the cat"
	in := []Suggestion{
		{Span: Span{Start: 0, End: 3}, Replacement: "the", Replacements: []string{"the"}, Model: ModelLLM},
	}
	require.Empty(t, cancelNoOpSuggestions(original, in),
		"replacement byte-identical to spanned original is a no-op")
}

// A real edit must be preserved by the no-op filter.
func TestDiffPreservesRealEditNearDeletion(t *testing.T) {
	original := "She has went"
	in := []Suggestion{
		{Span: Span{Start: 4, End: 7}, Replacement: "had", Replacements: []string{"had"}, Model: ModelLLM},
	}
	got := cancelNoOpSuggestions(original, in)
	require.Len(t, got, 1, "a genuine replacement must survive the no-op filter")
	require.Equal(t, "had", got[0].Replacement)
}

// End-to-end: identical original/corrected yields no suggestions (no churn).
func TestDiffPublicOutputHasNoNoOps(t *testing.T) {
	sugs := diffToSuggestions("I have a cat", "I have a cat")
	require.Empty(t, sugs)
}

// A legitimate word-move correction (delete a word, insert the same word
// elsewhere) must NOT be cancelled — applying the suggestions in reverse must
// reproduce the corrected text. Guards against an over-eager insert/delete
// no-op filter that would drop real transpositions.
func TestDiffPreservesWordMove(t *testing.T) {
	original := "please sign and date sign form"
	corrected := "please sign sign and date form"
	sugs := diffToSuggestions(original, corrected)
	require.NotEmpty(t, sugs, "a real word-move must produce suggestions")
	out := original
	for i := len(sugs) - 1; i >= 0; i-- {
		out = sugs[i].Apply(out)
	}
	require.Equal(t, corrected, out, "reverse-apply must reproduce the move")
}

// ---- same-word edit coalescing (verified live UX bug, 2026-06-10) ----
// The char-level diff can split ONE logical word fix into multiple minimal
// edits inside the SAME word (live: "tset"->"test" became [delete "s"] +
// [insert "s"], so the client's per-item word diff showed the nonsense
// "tset -> tet" and applying a single item produced a half-edit). Edits with
// no whitespace between their spans are coalesced into one suggestion whose
// replacement nets out the constituent edits.

func TestCoalesceMergesSameWordEdits(t *testing.T) {
	// "aa tset bb": delete "s" at [4,5) + insert "s" at [6,6) == "test".
	original := "aa tset bb" //nolint:misspell // intentional fixture
	in := []Suggestion{
		{Span: Span{4, 5}, Replacement: "", Replacements: []string{""}, Model: ModelLLM, Category: CategorySpelling},
		{Span: Span{6, 6}, Replacement: "s", Replacements: []string{"s"}, Model: ModelLLM, Category: CategorySpelling},
	}
	got := coalesceSameWordEdits(original, in)
	require.Len(t, got, 1, "two edits inside one word must coalesce")
	require.Equal(t, Span{4, 6}, got[0].Span)
	require.Equal(t, "es", got[0].Replacement)
	require.Equal(t, []string{"es"}, got[0].Replacements)
	require.Equal(t, ModelLLM, got[0].Model)
	require.Equal(t, CategorySpelling, got[0].Category)
	require.Equal(t, "aa test bb", applyAll(original, got),
		"coalescing must preserve the net applied text")
}

func TestCoalesceKeepsEditsInDifferentWords(t *testing.T) {
	// Fixture (misspelled article + verb): [0,3)->"the" and [8,14)->"ran"
	// sit in different words (whitespace in the gap) and must NOT merge.
	original := "teh cat runned" //nolint:misspell // intentional fixture
	in := []Suggestion{
		{Span: Span{0, 3}, Replacement: "the", Replacements: []string{"the"}, Model: ModelLLM},
		{Span: Span{8, 14}, Replacement: "ran", Replacements: []string{"ran"}, Model: ModelLLM},
	}
	got := coalesceSameWordEdits(original, in)
	require.Len(t, got, 2, "edits in different words stay separate")
	require.Equal(t, "the cat ran", applyAll(original, got))
}

func TestCoalesceChainsThreeEditsInOneWord(t *testing.T) {
	// Three minimal edits in one word collapse transitively into one.
	original := "x abcdef y"
	in := []Suggestion{
		{Span: Span{2, 3}, Replacement: "A", Replacements: []string{"A"}, Model: ModelLLM},
		{Span: Span{4, 5}, Replacement: "C", Replacements: []string{"C"}, Model: ModelLLM},
		{Span: Span{6, 6}, Replacement: "Z", Replacements: []string{"Z"}, Model: ModelLLM},
	}
	got := coalesceSameWordEdits(original, in)
	require.Len(t, got, 1)
	require.Equal(t, Span{2, 6}, got[0].Span)
	require.Equal(t, "AbCdZ", got[0].Replacement)
	require.Equal(t, "x AbCdZef y", applyAll(original, got))
}

func TestCoalesceSingleEditUnchanged(t *testing.T) {
	in := []Suggestion{{Span: Span{2, 5}, Replacement: "have", Replacements: []string{"have"}, Model: ModelLLM}}
	got := coalesceSameWordEdits("I has a cat", in)
	require.Equal(t, in, got, "a lone edit passes through unchanged")
}

func TestCoalesceLeavesInvalidSpansAlone(t *testing.T) {
	// An out-of-bounds span must pass through unmerged (Span.Validate is the
	// source of truth; the rest of the pipeline is robust to it).
	original := "ab"
	in := []Suggestion{
		{Span: Span{0, 1}, Replacement: "x", Replacements: []string{"x"}, Model: ModelLLM},
		{Span: Span{5, 9}, Replacement: "y", Replacements: []string{"y"}, Model: ModelLLM},
	}
	got := coalesceSameWordEdits(original, in)
	require.Len(t, got, 2, "invalid spans are never merged")
}

func TestDiffToSuggestionsCoalescesSplitWordFix(t *testing.T) {
	// End-to-end: whatever shape the char diff emits for a transposition
	// fix, the public output must be ONE suggestion per affected word and
	// applying it must yield the corrected text.
	original := "aa tset bb" //nolint:misspell // intentional fixture
	corrected := "aa test bb"
	got := diffToSuggestions(original, corrected)
	require.Len(t, got, 1, "one word fix -> one suggestion")
	require.Equal(t, corrected, applyAll(original, got))
}
