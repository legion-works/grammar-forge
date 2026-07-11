// Command overedit-fired lists, for every (rule, golden case) pair, whether
// the rule's repair function would have altered a LEGITIMATE correction —
// i.e. whether the rule "fires" on a pair that is NOT an over-edit. It
// exists to build the negative set for the per-rule fired-pair-conditioned
// threshold study (eval/overedit_rule_study.py, Task 10): a rule fires on a
// (rule, case) pair iff applying the rule to (input, golden) returns a
// string different from golden — the rule would have mangled a wanted fix.
// Untagged, pure Go: no cgo, no ONNX, no network I/O.
//
// Usage:
//
//	overedit-fired <golden.jsonl>
//
// Output (stdout): one line per firing (rule, case) pair, formatted
// `caseID<TAB>ruleID`. Deterministic order: golden JSONL order (outer loop),
// rules in DefaultNamedOverEditRules() registry order (inner loop). A pair
// that does not fire for a given rule is omitted.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/grammarforge/bridge/internal/correction"
)

type goldenCase struct {
	ID     json.Number `json:"id"`
	Cat    string      `json:"cat"`
	Input  string      `json:"input"`
	Golden string      `json:"golden"`
}

func main() {
	if len(os.Args) != 2 {
		log.Fatalf("usage: %s <golden.jsonl>", os.Args[0])
	}
	goldenPath := os.Args[1]

	cases, err := loadGolden(goldenPath)
	if err != nil {
		log.Fatalf("load golden: %v", err)
	}

	rules := correction.DefaultNamedOverEditRules()
	out := bufio.NewWriter(os.Stdout)

	for _, c := range cases {
		for _, r := range rules {
			if r.Repair(c.Input, c.Golden) == c.Golden {
				continue // rule did not fire on this pair
			}
			if _, err := fmt.Fprintf(out, "%s\t%s\n", c.ID.String(), r.ID); err != nil {
				log.Fatalf("write: %v", err)
			}
		}
	}

	if err := out.Flush(); err != nil {
		log.Fatalf("flush: %v", err)
	}
}

// loadGolden reads golden.jsonl (one JSON object per line, {id, cat, input,
// golden}) and returns the cases in file order.
func loadGolden(path string) ([]goldenCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cases []goldenCase
	dec := json.NewDecoder(bytes.NewReader(data))
	for dec.More() {
		var c goldenCase
		if err := dec.Decode(&c); err != nil {
			return nil, err
		}
		cases = append(cases, c)
	}
	return cases, nil
}
