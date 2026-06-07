package correction

import "testing"

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
