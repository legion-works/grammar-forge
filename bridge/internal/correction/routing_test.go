package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestShouldEscalateLongInput(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 10}
	if !p.ShouldEscalate("this is a long sentence", nil) {
		t.Error("long input should escalate")
	}
}

func TestShouldEscalateLowConfidence(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	low := []Suggestion{{Confidence: 0.4, Model: ModelGECToR}}
	if !p.ShouldEscalate("short", low) {
		t.Error("low confidence should escalate")
	}
	high := []Suggestion{{Confidence: 0.95, Model: ModelGECToR}}
	if p.ShouldEscalate("short", high) {
		t.Error("high confidence short input should NOT escalate")
	}
}

func TestShouldEscalateIgnoresHarperHighConfidenceWhenGECToRLow(t *testing.T) {
	// Harper emits a confident .95 spelling lint, but the structural-error
	// suggestion from GECToR is only .4 — the LLM must run to verify. The
	// old implementation took the best confidence across ALL fast
	// suggestions and was masked by Harper's fixed .95 floor.
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	fast := []Suggestion{
		{Confidence: 0.95, Model: ModelHarper, Span: Span{0, 4}},
		{Confidence: 0.4, Model: ModelGECToR, Span: Span{5, 8}},
	}
	if !p.ShouldEscalate("short sentence", fast) {
		t.Error("Harper's high confidence must not mask low GECToR confidence")
	}
}

func TestShouldEscalateFallsBackWhenNoGECToRSuggestions(t *testing.T) {
	// If only Harper ran (GECToR unavailable / produced nothing), keep
	// the historical behaviour: best-of-all confidence.
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	fast := []Suggestion{{Confidence: 0.95, Model: ModelHarper}}
	if p.ShouldEscalate("short", fast) {
		t.Error("Harper-only with high confidence should NOT escalate")
	}
	fastLow := []Suggestion{{Confidence: 0.3, Model: ModelHarper}}
	if !p.ShouldEscalate("short", fastLow) {
		t.Error("Harper-only with low confidence SHOULD escalate (fallback)")
	}
}

func TestShouldEscalateEmptyFastPathNonTrivial(t *testing.T) {
	// Bug #3: Harper+GECToR flag nothing on input with real errors they cannot
	// see (homophones/confusables). A non-trivial empty-fast-path input MUST
	// escalate so the LLM gets a chance.
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000, MinWordsForEscalation: 3}
	if !p.ShouldEscalate("I think your right about that", nil) {
		t.Error("non-trivial empty-fast-path input should escalate")
	}
}

func TestShouldEscalateEmptyFastPathTrivialDoesNot(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000, MinWordsForEscalation: 3}
	if p.ShouldEscalate("ok thanks", nil) {
		t.Error("trivial (<3 words) empty-fast-path input should NOT escalate")
	}
	if p.ShouldEscalate("yes", nil) {
		t.Error("single-word empty-fast-path input should NOT escalate")
	}
}

func TestShouldEscalateEmptyFastPathUsesDefaultMinWords(t *testing.T) {
	// MinWordsForEscalation unset (0) falls back to the package default (3).
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	if !p.ShouldEscalate("she go store today", nil) {
		t.Error("4-word input should escalate under the default min-words")
	}
	if p.ShouldEscalate("go now", nil) {
		t.Error("2-word input should not escalate under the default min-words")
	}
}

func TestShouldEscalate_OnFastEditWhenFlagged(t *testing.T) {
	// Harper lints carry a fixed 0.95 confidence, so a confident-but-wrong
	// fast edit would bypass the confidence-floor escalation. With
	// EscalateOnFastEdit set, any fast edit forces escalation so the LLM
	// (on the original) can override it. Off by default to preserve the
	// historical confidence-floor behaviour.
	fast := []Suggestion{{Span: Span{Start: 0, End: 1}, Replacement: "X", Model: ModelHarper, Confidence: 0.95}}
	on := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true}
	off := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: false}
	if !on.ShouldEscalate("a short clean-ish line", fast) {
		t.Error("EscalateOnFastEdit=true with any fast edit must escalate")
	}
	if off.ShouldEscalate("a short clean-ish line", fast) {
		t.Error("EscalateOnFastEdit=false must preserve the high-confidence short path")
	}
}

func TestShouldEscalate_OnFastEdit_NoEditsNoForce(t *testing.T) {
	// EscalateOnFastEdit only forces escalation when the fast path actually
	// produced an edit. With no fast suggestions, the policy must still defer
	// to the long-input / non-trivial-input rules (mirrors the
	// MinWordsForEscalation gate).
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true, MinWordsForEscalation: 3}
	if pol.ShouldEscalate("hi", nil) {
		t.Error("trivial empty-fast-path input should NOT escalate")
	}
	if !pol.ShouldEscalate("this is a longer line", nil) {
		t.Error("non-trivial empty-fast-path input should escalate")
	}
}

func TestMergeDedupPrefersHigherConfidenceOnOverlap(t *testing.T) {
	a := Suggestion{Span: Span{2, 5}, Replacement: "have", Model: ModelGECToR, Confidence: 0.9}
	b := Suggestion{Span: Span{2, 5}, Replacement: "have", Model: ModelLLM, Confidence: 0.5}
	got := mergeSuggestions([]Suggestion{a, b})
	if len(got) != 1 {
		t.Fatalf("want 1 deduped, got %d", len(got))
	}
	if got[0].Model != ModelGECToR {
		t.Errorf("kept lower-confidence dup")
	}
}

func TestMergeDedupKeepsHigherConfidenceOnDifferentStartOverlap(t *testing.T) {
	// Earlier-starting LOWER-confidence span would be kept by the old sort
	// (ascending span start). The correct behaviour is greedy by confidence
	// DESC: the .9 [2,4] overlaps the .1 [0,10] and must win; the outer span
	// is dropped. This mirrors how a real corrector should surface the
	// high-confidence edit and discard the speculative low-confidence one
	// that subsumes it.
	low := Suggestion{Span: Span{0, 10}, Replacement: "X", Model: ModelLLM, Confidence: 0.1}
	high := Suggestion{Span: Span{2, 4}, Replacement: "Y", Model: ModelGECToR, Confidence: 0.9}
	got := mergeSuggestions([]Suggestion{low, high})
	if len(got) != 1 {
		t.Fatalf("want 1 deduped, got %d: %+v", len(got), got)
	}
	if got[0].Confidence != 0.9 {
		t.Errorf("dropped higher-confidence suggestion; kept conf=%v", got[0].Confidence)
	}
	if got[0].Span != (Span{2, 4}) {
		t.Errorf("kept wrong span: %+v", got[0].Span)
	}
}

func TestMergeDedupResultIsSortedBySpanStart(t *testing.T) {
	// After dedup, surviving suggestions are sorted by span start for
	// deterministic downstream application (apply last-to-first).
	keep := []Suggestion{
		{Span: Span{5, 7}, Replacement: "b", Model: ModelGECToR, Confidence: 0.8},
		{Span: Span{0, 2}, Replacement: "a", Model: ModelGECToR, Confidence: 0.7},
		{Span: Span{9, 11}, Replacement: "c", Model: ModelHarper, Confidence: 0.95},
	}
	got := mergeSuggestions(keep)
	if len(got) != 3 {
		t.Fatalf("want 3 kept, got %d", len(got))
	}
	if got[0].Span.Start != 0 || got[1].Span.Start != 5 || got[2].Span.Start != 9 {
		t.Errorf("result not sorted by span start: %+v", got)
	}
}

func TestMergeCategoryTieBreakerEqualConfidence(t *testing.T) {
	// Same span, EQUAL confidence: higher-priority category (spelling) wins.
	in := []Suggestion{
		{Span: Span{0, 3}, Replacement: "the", Confidence: 0.9, Category: CategoryGrammar},
		{Span: Span{0, 3}, Replacement: "teh", Confidence: 0.9, Category: CategorySpelling}, //nolint:misspell // intentional fixture
	}
	got := mergeSuggestions(in)
	require.Len(t, got, 1)
	require.Equal(t, CategorySpelling, got[0].Category)
}

func TestMergeConfidenceBeatsCategory(t *testing.T) {
	// Higher-confidence GRAMMAR must beat lower-confidence SPELLING on overlap
	// (eval-safety: category never preempts confidence → no applied-output change).
	in := []Suggestion{
		{Span: Span{0, 3}, Replacement: "g", Confidence: 0.95, Category: CategoryGrammar},
		{Span: Span{0, 3}, Replacement: "s", Confidence: 0.50, Category: CategorySpelling},
	}
	got := mergeSuggestions(in)
	require.Len(t, got, 1)
	require.Equal(t, 0.95, got[0].Confidence)
	require.Equal(t, CategoryGrammar, got[0].Category)
}

func TestMergeNonOverlappingBothKept(t *testing.T) {
	in := []Suggestion{
		{Span: Span{0, 3}, Confidence: 0.9, Category: CategorySpelling},
		{Span: Span{5, 8}, Confidence: 0.9, Category: CategoryGrammar},
	}
	require.Len(t, mergeSuggestions(in), 2)
}

func TestPropagateFastCategoriesTagsSpelling(t *testing.T) {
	// LLM diff edit (grammar/"") overlapping a Harper spelling span inherits
	// spelling; a grammar edit with no overlap stays grammar.
	llm := []Suggestion{
		{Span: Span{8, 10}, Replacement: "ei", Category: CategoryGrammar}, // inside the misspelled word
		{Span: Span{0, 3}, Replacement: "is", Category: CategoryGrammar},  // "are" -> "is"
	}
	fast := []Suggestion{
		{Span: Span{4, 11}, Replacement: "receive", Category: CategorySpelling, Model: ModelHarper},
	}
	got := propagateFastCategories(llm, fast)
	require.Equal(t, CategorySpelling, got[0].Category, "overlapping the Harper spelling span -> spelling")
	require.Equal(t, CategoryGrammar, got[1].Category, "no overlap -> stays grammar")
}

func TestPropagateFastCategoriesNoopWhenEmpty(t *testing.T) {
	llm := []Suggestion{{Span: Span{0, 3}, Category: CategoryGrammar}}
	require.Equal(t, llm, propagateFastCategories(llm, nil))
	require.Empty(t, propagateFastCategories(nil, []Suggestion{{Span: Span{0, 1}, Category: CategorySpelling}}))
}

func TestPropagateFastCategoriesDoesNotOverrideSpecific(t *testing.T) {
	// An already-specific category (e.g. style) is not overwritten.
	llm := []Suggestion{{Span: Span{0, 3}, Category: CategoryStyle}}
	fast := []Suggestion{{Span: Span{0, 3}, Category: CategorySpelling}}
	require.Equal(t, CategoryStyle, propagateFastCategories(llm, fast)[0].Category)
}

func TestShouldEscalate_SkipsAllSpellingFastEditsWhenFlagged(t *testing.T) {
	// Spelling lints come from Harper's dictionary engine (incl. the user
	// dictionary the LLM cannot see); with the skip flag, an ALL-spelling
	// fast result is served directly instead of burning an LLM round-trip.
	spelling := []Suggestion{
		{Span: Span{Start: 0, End: 5}, Replacement: "X", Model: ModelHarper, Confidence: 0.95, Category: CategorySpelling},
		{Span: Span{Start: 6, End: 9}, Replacement: "Y", Model: ModelHarper, Confidence: 0.95, Category: CategorySpelling},
	}
	mixed := []Suggestion{
		{Span: Span{Start: 0, End: 5}, Replacement: "X", Model: ModelHarper, Confidence: 0.95, Category: CategorySpelling},
		{Span: Span{Start: 6, End: 9}, Replacement: "Y", Model: ModelGECToR, Confidence: 0.95, Category: CategoryGrammar},
	}
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true, SkipLLMForSpellingOnly: true}
	if pol.ShouldEscalate("a short line with typos", spelling) {
		t.Error("all-spelling fast edits with the skip flag must NOT escalate")
	}
	if !pol.ShouldEscalate("a short line with typos", mixed) {
		t.Error("mixed-category fast edits must still escalate")
	}
	off := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true}
	if !off.ShouldEscalate("a short line with typos", spelling) {
		t.Error("without the skip flag all-spelling fast edits must escalate (current default)")
	}
}

func TestShouldEscalate_SkipSpellingStillHonorsConfidenceFloor(t *testing.T) {
	// The exemption only bypasses the EscalateOnFastEdit trigger — a
	// low-confidence spelling edit still falls through to the confidence
	// floor and escalates.
	low := []Suggestion{{Span: Span{Start: 0, End: 5}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3, Category: CategorySpelling}}
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true, SkipLLMForSpellingOnly: true}
	if !pol.ShouldEscalate("a short line", low) {
		t.Error("a low-confidence spelling-only edit must still escalate")
	}
}
