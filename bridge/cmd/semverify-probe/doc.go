//go:build !cgo || !ORT

// Command semverify-probe runs the in-process MiniLM semantic verifier against
// the same pairs the Python calibration script scored, and emits TSV
// (id<TAB>cosine) for downstream diff. It exists to validate that
// sentence-transformers/all-MiniLM-L6-v2 (Python) and hugot's ONNX backend
// (Go) agree to within ~0.02 per pair — otherwise the proxy assumption is
// broken and the Python study is not a valid substitute for the real
// bridge path.
//
// The real implementation is gated to cgo && ORT (see main.go); this file
// is the stub so `go build ./...` succeeds without the native libs. The
// stub refuses to run and prints a hint to use the Docker build instead.
package main

import "fmt"

func main() {
	fmt.Println("semverify-probe requires -tags ORT; build inside the grammarforge-bridge:dev image")
}
