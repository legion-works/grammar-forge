package correction

import (
	"encoding/json"
	"fmt"
	"strings"
)

// parseToneTags extracts tone tags from a (possibly prose- or fence-wrapped)
// LLM response: it strips a ```json fence, isolates the first '{' .. last '}',
// unmarshals, lowercases + filters to the fixed vocabulary, dedups, and clamps
// confidence to [0,1]. Returns an error only when no JSON object can be located
// or it fails to unmarshal.
func parseToneTags(raw string) ([]ToneTag, error) {
	s := extractJSONObject(raw)
	if s == "" {
		return nil, fmt.Errorf("tone: no JSON object in response")
	}
	var parsed struct {
		Tags []struct {
			Tag        string  `json:"tag"`
			Confidence float64 `json:"confidence"`
		} `json:"tags"`
	}
	if err := json.Unmarshal([]byte(s), &parsed); err != nil {
		return nil, fmt.Errorf("tone: parse JSON: %w", err)
	}
	out := make([]ToneTag, 0, len(parsed.Tags))
	seen := make(map[string]struct{}, len(parsed.Tags))
	for _, t := range parsed.Tags {
		tag := strings.ToLower(strings.TrimSpace(t.Tag))
		if !allowedToneTag(tag) {
			continue
		}
		if _, dup := seen[tag]; dup {
			continue
		}
		seen[tag] = struct{}{}
		c := t.Confidence
		if c < 0 {
			c = 0
		}
		if c > 1 {
			c = 1
		}
		out = append(out, ToneTag{Tag: tag, Confidence: c})
	}
	return out, nil
}

// tryBalancedSpanFrom walks forward from s[i] counting '{' / '}' depth and
// returns (span, valid) where span is the balanced '{..}' substring (when the
// depth returns to 0) and valid is true iff json.Valid accepts it. Returns
// ("", false) on an unbalanced '{' (depth never returns to 0 within s). The
// depth counter is naive — it does not understand JSON string quoting — so a
// '}' inside a string value closes the candidate early and the resulting
// span is almost certainly not valid JSON; the caller (extractJSONObject)
// skips it and tries the next '{'.
func tryBalancedSpanFrom(s string, i int) (string, bool) {
	depth := 0
	for j := i; j < len(s); j++ {
		switch s[j] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				span := s[i : j+1]
				return span, json.Valid([]byte(span))
			}
		}
	}
	return "", false
}

// extractJSONObject returns the substring of the first JSON-valid balanced
// '{' .. '}' span (inclusive), after stripping a leading ```json / trailing ```
// fence. Returns "" if no candidate parses. The balanced scan tolerates a
// stray '{' in surrounding prose (e.g. `Result {score}: {"tags":[]}`) that a
// naive first-'{'/last-'}' grab would mistranslate; the json.Valid check
// backtracks past a balanced-but-non-JSON candidate (a `{x}` in prose, or a
// naive span that closes on a '}' inside a string value) to the next '{'.
// Finding-2 behaviour: when the LLM returns multiple valid JSON objects, the
// FIRST wins; if the first is the empty-tagging shape and we want tags, the
// second is not consulted. The double-parse cost (this + parseToneTags) is
// negligible for tone response sizes.
//
// Termination: each outer-loop iteration strictly advances `s` to `s[i+1:]`,
// so the string shrinks every iteration. Provably no infinite loop, even on
// pathological inputs like `"a}b"` (a '}' inside a string value that closes
// the naive depth counter early) or `"prose { with no close"` (an unbalanced
// '{' with no matching '}').
func extractJSONObject(raw string) string {
	s := strings.TrimSpace(raw)
	if i := strings.Index(s, "```"); i >= 0 {
		s = s[i+3:]
		if j := strings.LastIndex(s, "```"); j >= 0 {
			s = s[:j]
		}
		s = strings.TrimPrefix(strings.TrimSpace(s), "json")
	}
	for {
		i := strings.Index(s, "{")
		if i < 0 {
			return ""
		}
		span, valid := tryBalancedSpanFrom(s, i)
		if valid {
			return span
		}
		s = s[i+1:]
	}
}
