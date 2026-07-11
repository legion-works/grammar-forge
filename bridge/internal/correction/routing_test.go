package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestShouldEscalateLongInput(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 10}
	if !p.ShouldEscalate("this is a long sentence", nil, nil) {
		t.Error("long input should escalate")
	}
}

func TestShouldEscalateLowConfidence(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	low := []Suggestion{{Confidence: 0.4, Model: ModelGECToR}}
	if !p.ShouldEscalate("short", low, nil) {
		t.Error("low confidence should escalate")
	}
	high := []Suggestion{{Confidence: 0.95, Model: ModelGECToR}}
	if p.ShouldEscalate("short", high, nil) {
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
	if !p.ShouldEscalate("short sentence", fast, nil) {
		t.Error("Harper's high confidence must not mask low GECToR confidence")
	}
}

func TestShouldEscalateFallsBackWhenNoGECToRSuggestions(t *testing.T) {
	// If only Harper ran (GECToR unavailable / produced nothing), keep
	// the historical behaviour: best-of-all confidence.
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	fast := []Suggestion{{Confidence: 0.95, Model: ModelHarper}}
	if p.ShouldEscalate("short", fast, nil) {
		t.Error("Harper-only with high confidence should NOT escalate")
	}
	fastLow := []Suggestion{{Confidence: 0.3, Model: ModelHarper}}
	if !p.ShouldEscalate("short", fastLow, nil) {
		t.Error("Harper-only with low confidence SHOULD escalate (fallback)")
	}
}

func TestShouldEscalateEmptyFastPathNonTrivial(t *testing.T) {
	// Bug #3: Harper+GECToR flag nothing on input with real errors they cannot
	// see (homophones/confusables). A non-trivial empty-fast-path input MUST
	// escalate so the LLM gets a chance.
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000, MinWordsForEscalation: 3}
	if !p.ShouldEscalate("I think your right about that", nil, nil) {
		t.Error("non-trivial empty-fast-path input should escalate")
	}
}

func TestShouldEscalateEmptyFastPathTrivialDoesNot(t *testing.T) {
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000, MinWordsForEscalation: 3}
	if p.ShouldEscalate("ok thanks", nil, nil) {
		t.Error("trivial (<3 words) empty-fast-path input should NOT escalate")
	}
	if p.ShouldEscalate("yes", nil, nil) {
		t.Error("single-word empty-fast-path input should NOT escalate")
	}
}

func TestShouldEscalateEmptyFastPathUsesDefaultMinWords(t *testing.T) {
	// MinWordsForEscalation unset (0) falls back to the package default (3).
	p := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 1000}
	if !p.ShouldEscalate("she go store today", nil, nil) {
		t.Error("4-word input should escalate under the default min-words")
	}
	if p.ShouldEscalate("go now", nil, nil) {
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
	if !on.ShouldEscalate("a short clean-ish line", fast, nil) {
		t.Error("EscalateOnFastEdit=true with any fast edit must escalate")
	}
	if off.ShouldEscalate("a short clean-ish line", fast, nil) {
		t.Error("EscalateOnFastEdit=false must preserve the high-confidence short path")
	}
}

func TestShouldEscalate_OnFastEdit_NoEditsNoForce(t *testing.T) {
	// EscalateOnFastEdit only forces escalation when the fast path actually
	// produced an edit. With no fast suggestions, the policy must still defer
	// to the long-input / non-trivial-input rules (mirrors the
	// MinWordsForEscalation gate).
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true, MinWordsForEscalation: 3}
	if pol.ShouldEscalate("hi", nil, nil) {
		t.Error("trivial empty-fast-path input should NOT escalate")
	}
	if !pol.ShouldEscalate("this is a longer line", nil, nil) {
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
	if pol.ShouldEscalate("a short line with typos", spelling, nil) {
		t.Error("all-spelling fast edits with the skip flag must NOT escalate")
	}
	if !pol.ShouldEscalate("a short line with typos", mixed, nil) {
		t.Error("mixed-category fast edits must still escalate")
	}
	off := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true}
	if !off.ShouldEscalate("a short line with typos", spelling, nil) {
		t.Error("without the skip flag all-spelling fast edits must escalate (current default)")
	}
}

func TestShouldEscalate_SkipSpellingStillHonorsConfidenceFloor(t *testing.T) {
	// The exemption only bypasses the EscalateOnFastEdit trigger — a
	// low-confidence spelling edit still falls through to the confidence
	// floor and escalates.
	low := []Suggestion{{Span: Span{Start: 0, End: 5}, Replacement: "X", Model: ModelGECToR, Confidence: 0.3, Category: CategorySpelling}}
	pol := EscalationPolicy{MinConfidence: 0.7, MaxSentenceLen: 200, EscalateOnFastEdit: true, SkipLLMForSpellingOnly: true}
	if !pol.ShouldEscalate("a short line", low, nil) {
		t.Error("a low-confidence spelling-only edit must still escalate")
	}
}

// Phase-B: TrustedCategories generalizes the spelling-only skip into a
// configurable category set. Skip escalation when EVERY fast suggestion's
// Category is in the trusted set; empty set falls back to the legacy
// SkipLLMForSpellingOnly check verbatim; SkipLLMForSpellingOnly=true remains
// equivalent to TrustedCategories=[CategorySpelling].
//
// Each policy literal below sets MaxSentenceLen=200 and MinConfidence=0 so
// only the EscalateOnFastEdit / trusted-set branches decide the outcome
// (matches the legacy SkipLLMForSpellingOnly test fixture's pattern).

func TestTrustedCategoriesSkipsEscalation(t *testing.T) {
	// Spelling + typography trusted; fast result is one of each. With the
	// generalisation, no all-spelling-only requirement anymore — every
	// suggestion just needs to be a trusted category.
	p := EscalationPolicy{
		MaxSentenceLen:     200,
		MinConfidence:      0.7,
		EscalateOnFastEdit: true,
		TrustedCategories:  []string{CategorySpelling, CategoryTypography},
	}
	fast := []Suggestion{
		{Category: CategorySpelling, Confidence: 0.95},
		{Category: CategoryTypography, Confidence: 0.9},
	}
	require.False(t, p.ShouldEscalate("Teh word — nice.", fast, nil)) //nolint:misspell // intentional fixture
}

func TestUntrustedCategoryStillEscalates(t *testing.T) {
	// Mixed fast result: a trusted spelling edit next to an untrusted
	// grammar edit. Mixed contents must still escalate so the LLM can
	// arbitrate the grammar edit.
	p := EscalationPolicy{
		MaxSentenceLen:     200,
		MinConfidence:      0.7,
		EscalateOnFastEdit: true,
		TrustedCategories:  []string{CategorySpelling},
	}
	fast := []Suggestion{
		{Category: CategorySpelling, Confidence: 0.95},
		{Category: CategoryGrammar, Confidence: 0.9},
	}
	require.True(t, p.ShouldEscalate("She go to teh school.", fast, nil)) //nolint:misspell // intentional fixture
}

func TestEmptyTrustedFallsBackToLegacyFlag(t *testing.T) {
	// TrustedCategories empty + legacy SkipLLMForSpellingOnly=true: the
	// skip still fires for an all-spelling fast result (back-compat).
	p := EscalationPolicy{
		MaxSentenceLen:         200,
		MinConfidence:          0.7,
		EscalateOnFastEdit:     true,
		SkipLLMForSpellingOnly: true,
	}
	fast := []Suggestion{{Category: CategorySpelling, Confidence: 0.95}}
	require.False(t, p.ShouldEscalate("Teh word.", fast, nil)) //nolint:misspell // intentional fixture
}

func TestTrustedCategoriesNeverTrustsGrammar(t *testing.T) {
	// Belt-and-braces: even if the parser let "" through (it rejects it),
	// the routing layer must still escalate a CategoryGrammar edit. Grammar
	// errors (agreement, syntax, ...) are exactly what the LLM is needed to
	// override — the trust set must never include grammar.
	p := EscalationPolicy{
		MaxSentenceLen:     200,
		MinConfidence:      0.7,
		EscalateOnFastEdit: true,
		TrustedCategories:  []string{""}, // parser rejects; defensive test
	}
	fast := []Suggestion{{Category: CategoryGrammar, Confidence: 0.9}}
	require.True(t, p.ShouldEscalate("She go.", fast, nil),
		"CategoryGrammar must never be trusted regardless of set contents")
}

func TestTrustedCategoriesStackedWithLegacyFlag(t *testing.T) {
	// Both TrustedCategories AND SkipLLMForSpellingOnly set: their effects
	// stack — the trust set is the union. A typography-only fast result is
	// skipped here even though the legacy flag alone would only have
	// trusted spelling.
	p := EscalationPolicy{
		EscalateOnFastEdit:     true,
		MaxSentenceLen:         200,
		MinConfidence:          0.5,
		SkipLLMForSpellingOnly: true,
		TrustedCategories:      []string{CategoryTypography},
	}
	fast := []Suggestion{{Category: CategoryTypography, Confidence: 0.95}}
	require.False(t, p.ShouldEscalate("the word — nice.", fast, nil),
		"trusted-set union (spelling+typography) must skip typography-only fast edits")
}

// Task 5: calibrated escalation. These fixtures ALL use EscalateOnFastEdit
// with an empty trust set (TrustedCategories/SkipLLMForSpellingOnly both
// unset), so everyCategoryTrusted always fails and the ONLY way to avoid the
// legacy unconditional "return true" is the new calibrated-skip check.

func TestCalibratedEscalation_AllConfidentNonGrammarSkips(t *testing.T) {
	p := EscalationPolicy{MaxSentenceLen: 200, MinConfidence: 0.7, EscalateOnFastEdit: true}
	fast := []Suggestion{
		{Category: CategorySpelling, Confidence: 0.5},
		{Category: CategoryPunctuation, Confidence: 0.5},
	}
	calibrated := func(Suggestion) (float64, bool) { return 0.9, true }
	require.False(t, p.ShouldEscalate("short line", fast, calibrated),
		"every fast suggestion non-grammar + calibrated >= MinConfidence must skip the LLM")
}

func TestCalibratedEscalation_OneUncalibratedStillEscalates(t *testing.T) {
	p := EscalationPolicy{MaxSentenceLen: 200, MinConfidence: 0.7, EscalateOnFastEdit: true}
	fast := []Suggestion{
		{Category: CategorySpelling, Confidence: 0.5},
		{Category: CategoryPunctuation, Confidence: 0.5},
	}
	calls := 0
	calibrated := func(s Suggestion) (float64, bool) {
		calls++
		if s.Category == CategoryPunctuation {
			return 0, false // cold bucket / unknown -> caller must keep raw and escalate
		}
		return 0.9, true
	}
	require.True(t, p.ShouldEscalate("short line", fast, calibrated),
		"any suggestion the calibrator does not confidently vouch for must still escalate")
	require.Positive(t, calls, "calibrated closure must actually be consulted")
}

func TestCalibratedEscalation_GrammarNeverSkips(t *testing.T) {
	p := EscalationPolicy{MaxSentenceLen: 200, MinConfidence: 0.7, EscalateOnFastEdit: true}
	fast := []Suggestion{
		{Category: CategorySpelling, Confidence: 0.5},
		{Category: CategoryGrammar, Confidence: 0.5},
	}
	calibrated := func(Suggestion) (float64, bool) { return 0.99, true }
	require.True(t, p.ShouldEscalate("short line", fast, calibrated),
		"CategoryGrammar must never be skipped via calibration, mirroring the Phase-B trusted-set invariant")
}

func TestCalibratedEscalation_ZeroFloorDisablesSkip(t *testing.T) {
	// MinConfidence == 0 means the confidence floor is disabled (see the
	// legacy `best < p.MinConfidence` check, which is always false when
	// MinConfidence is 0). The calibrated-skip block mirrors that: a zero
	// floor must not be treated as "any calibrated value clears it".
	p := EscalationPolicy{MaxSentenceLen: 200, MinConfidence: 0, EscalateOnFastEdit: true}
	fast := []Suggestion{{Category: CategorySpelling, Confidence: 0.5}}
	calibrated := func(Suggestion) (float64, bool) { return 0.99, true }
	require.True(t, p.ShouldEscalate("short line", fast, calibrated),
		"MinConfidence=0 must disable the calibrated skip, not vacuously satisfy it")
}
