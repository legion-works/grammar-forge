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
