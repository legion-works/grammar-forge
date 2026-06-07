package correction

import (
	"strings"
	"testing"
)

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

func TestApplyMultibyteByteOffsets(t *testing.T) {
	original := "café costs €5" // 'é' and '€' are multibyte UTF-8
	// replace "€5" (byte offsets): compute with strings.Index
	start := strings.Index(original, "€5")
	s := Suggestion{Span: Span{Start: start, End: start + len("€5")}, Replacement: "$6", Model: ModelLLM}
	if got := s.Apply(original); got != "café costs $6" {
		t.Fatalf("Apply() = %q", got)
	}
}

func TestValidateUsesByteLength(t *testing.T) {
	original := "café" // 5 bytes, 4 runes
	if err := (Span{Start: 0, End: 5}).Validate(len(original)); err != nil {
		t.Fatalf("byte span [0,5) should be valid for 5-byte string: %v", err)
	}
}
