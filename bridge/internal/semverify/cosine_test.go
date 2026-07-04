package semverify

import (
	"math"
	"testing"
)

func TestCosineIdentical(t *testing.T) {
	v := []float32{0.5, -0.2, 0.8}
	if got := Cosine(v, v); math.Abs(got-1.0) > 1e-6 {
		t.Fatalf("cosine(v,v) = %v, want 1.0", got)
	}
}

func TestCosineOrthogonal(t *testing.T) {
	if got := Cosine([]float32{1, 0}, []float32{0, 1}); math.Abs(got) > 1e-6 {
		t.Fatalf("orthogonal cosine = %v, want 0", got)
	}
}

func TestCosineZeroVectorIsZero(t *testing.T) {
	if got := Cosine([]float32{0, 0}, []float32{1, 1}); got != 0 {
		t.Fatalf("zero-vector cosine = %v, want 0", got)
	}
}

func TestCosineLengthMismatchIsZero(t *testing.T) {
	if got := Cosine([]float32{1, 0, 0}, []float32{1, 0}); got != 0 {
		t.Fatalf("length-mismatch cosine = %v, want 0", got)
	}
}
