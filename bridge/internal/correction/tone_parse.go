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

// extractJSONObject returns the substring from the first '{' to the last '}'
// (inclusive), after stripping a leading ```json / trailing ``` fence. Returns
// "" if no braces are found.
func extractJSONObject(raw string) string {
	s := strings.TrimSpace(raw)
	if i := strings.Index(s, "```"); i >= 0 {
		s = s[i+3:]
		if j := strings.LastIndex(s, "```"); j >= 0 {
			s = s[:j]
		}
		s = strings.TrimPrefix(strings.TrimSpace(s), "json")
	}
	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start < 0 || end < 0 || end < start {
		return ""
	}
	return s[start : end+1]
}
