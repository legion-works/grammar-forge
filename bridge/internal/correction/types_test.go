package correction

import "testing"

func TestApplyReplacesSpan(t *testing.T) {
	original := "I has a cat"
	s := Suggestion{
		Span:        Span{Start: 2, End: 5}, // "has"
		Replacement: "have",
		Model:       ModelGECToR,
	}
	got := s.Apply(original)
	want := "I have a cat"
	if got != want {
		t.Fatalf("Apply() = %q, want %q", got, want)
	}
}

func TestSpanValidateRejectsInverted(t *testing.T) {
	if err := (Span{Start: 5, End: 2}).Validate(11); err == nil {
		t.Fatal("expected error for inverted span")
	}
	if err := (Span{Start: 0, End: 12}).Validate(11); err == nil {
		t.Fatal("expected error for out-of-range span")
	}
	if err := (Span{Start: 2, End: 5}).Validate(11); err != nil {
		t.Fatalf("unexpected error for valid span: %v", err)
	}
}
