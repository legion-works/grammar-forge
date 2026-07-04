//go:build cgo && ORT

// Command semverify-probe runs the in-process MiniLM semantic verifier against
// the same pairs the Python calibration script scored, and emits TSV
// (`id<TAB>cosine`) for downstream diff. It exists to validate that
// sentence-transformers/all-MiniLM-L6-v2 (Python) and hugot's ONNX backend
// (Go) agree to within ~0.02 per pair — otherwise the proxy assumption is
// broken and the Python study is not a valid substitute for the real
// bridge path.
//
// Usage:
//
//	semverify-probe <modelPath> <fixtures.jsonl> <golden.jsonl>
//
// Output (stdout): one line per pair, formatted `id<TAB>cosine` (6 dp).
// Fixture pairs are tagged `f<index>` (matching verifier_calibration.py),
// golden pairs `g<id>`. Pairs are deterministic: fixtures first, then golden
// in JSONL order. stderr logs load progress.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"

	"github.com/grammarforge/bridge/internal/semverify"
)

type fixturePair struct {
	Original   string `json:"original"`
	OverEdited string `json:"overedited"`
}

type goldenPair struct {
	ID     json.Number `json:"id"`
	Cat    string      `json:"cat"`
	Input  string      `json:"input"`
	Golden string      `json:"golden"`
}

func main() {
	if len(os.Args) != 4 {
		log.Fatalf("usage: %s <modelPath> <fixtures.jsonl> <golden.jsonl>", os.Args[0])
	}
	modelPath, fixturesPath, goldenPath := os.Args[1], os.Args[2], os.Args[3]

	v, err := semverify.New(modelPath)
	if err != nil {
		log.Fatalf("semverify init: %v", err)
	}
	defer func() { _ = v.Close() }()

	pairs := loadPairs(fixturesPath, goldenPath)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	ctx := context.Background()
	for _, p := range pairs {
		sim, err := v.Similarity(ctx, p.A, p.B)
		if err != nil {
			log.Fatalf("similarity %s: %v", p.ID, err)
		}
		if _, err := fmt.Fprintf(out, "%s\t%.6f\n", p.ID, sim); err != nil {
			log.Fatalf("write: %v", err)
		}
	}
}

type pair struct {
	ID, A, B string
}

func loadPairs(fixturesPath, goldenPath string) []pair {
	var pairs []pair

	data, err := os.ReadFile(fixturesPath)
	if err != nil {
		log.Fatalf("read fixtures: %v", err)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var f fixturePair
		if err := dec.Decode(&f); err != nil {
			log.Fatalf("decode fixture: %v", err)
		}
		pairs = append(pairs, pair{ID: "f" + strconv.Itoa(len(pairs)), A: f.Original, B: f.OverEdited})
	}

	data, err = os.ReadFile(goldenPath)
	if err != nil {
		log.Fatalf("read golden: %v", err)
	}
	dec = json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var g goldenPair
		if err := dec.Decode(&g); err != nil {
			log.Fatalf("decode golden: %v", err)
		}
		pairs = append(pairs, pair{ID: "g" + g.ID.String(), A: g.Input, B: g.Golden})
	}
	return pairs
}
