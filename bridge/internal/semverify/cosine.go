// Package semverify implements the post-LLM semantic verifier: an all-MiniLM-L6-v2
// embedding similarity gate (mean-pooled, L2-normalized, cosine) used to discard
// catastrophic LLM rewrites before they are diffed into user-visible suggestions.
// The ONNX-backed Verifier lives behind the cgo && ORT build tag (semverify.go);
// Cosine and its test are tag-free pure math so the package always compiles.
package semverify

import "math"

// Cosine returns the cosine similarity of two equal-length vectors.
// A zero-magnitude or length-mismatched input yields 0 (defensive:
// never NaN — the verifier gate treats 0 as maximal dissimilarity,
// which fails CLOSED here but the service layer fails OPEN on error,
// so a malformed embedding can only ever suppress an LLM rewrite,
// never fabricate one).
func Cosine(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}
