package correction

import (
	"strings"
	"testing"
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
