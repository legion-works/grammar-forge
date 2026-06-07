package correction

import "testing"

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
