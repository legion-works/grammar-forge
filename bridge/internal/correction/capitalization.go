package correction

import "strings"

// midSentenceCapStoplist is the curated set of unambiguous function words that
// are NEVER proper nouns. A Harper "capitalize at sentence start" suggestion
// that uppercases one of these words at a non-sentence-start position is a
// misfire and should be dropped.
//
// Inclusion criteria: the word must be unambiguously a function word in every
// context — it must never double as a proper noun, month, name, or title.
//
// Explicit exclusions (NOT in this list):
//   - "i" — always correct to capitalize (first-person pronoun)
//   - "may" — month name (May)
//   - "march" — month name (March)
//   - "mark", "bill", "rose", "will", "grace", "faith", "hope" — common names
//   - any word that can be a proper noun or title
var midSentenceCapStoplist = func() map[string]struct{} {
	words := []string{
		// articles
		"a", "an", "the",
		// coordinating conjunctions (FANBOYS minus "for" which can be a preposition)
		"and", "but", "or", "nor", "so", "yet",
		// subordinating conjunctions
		"if", "as", "because", "although", "while", "when", "where",
		"which", "that", "than", "then", "though", "unless", "until",
		"since", "after", "before", "once", "whether",
		// prepositions (unambiguous ones only)
		"on", "in", "at", "to", "of", "with", "by", "from", "about",
		"into", "over", "under", "between", "through", "during",
		"against", "along", "among", "around", "behind", "below",
		"beside", "beyond", "despite", "except", "inside", "near",
		"off", "onto", "outside", "past", "per", "plus", "regarding",
		"throughout", "toward", "towards", "upon", "via", "within",
		"without",
		// personal pronouns (excluding "i" — always capitalize)
		"he", "she", "it", "we", "they", "you",
		"him", "her", "them", "us",
		"his", "its", "our", "their", "your", "my", "me",
		// demonstratives
		"this", "these", "those",
		// auxiliary verbs (unambiguous ones only — exclude "may", "will")
		"is", "was", "were", "are", "be", "been", "am",
		"do", "does", "did", "has", "have", "had",
		"would", "can", "could", "should", "might", "must",
		// negation / adverbs that are never names
		"not", "no", "very", "just", "also", "too", "only", "even",
		"still", "already", "always", "never", "often", "quite",
		"rather", "really", "soon", "then", "there", "thus",
		// relative/interrogative (unambiguous)
		"whose", "whom",
		// other unambiguous function words
		"both", "each", "either", "neither", "every", "all", "any",
		"few", "more", "most", "other", "some", "such",
		"what", "whatever", "whenever", "wherever", "whichever",
		"how", "however",
	}
	m := make(map[string]struct{}, len(words))
	for _, w := range words {
		m[w] = struct{}{}
	}
	return m
}()

// dropMidSentenceCapitalization filters Harper "capitalize at sentence start"
// suggestions that fire at non-sentence-start positions. Only suggestions that
// uppercase an unambiguous function word (in midSentenceCapStoplist) at a
// position NOT preceded by a sentence-ending punctuation mark are dropped.
// All other suggestions — including proper-noun capitalizations, "i"→"I",
// and true sentence-start capitalizations — are preserved unchanged.
//
// Parameters:
//   - enabled: when false, returns suggs unchanged (no-op).
//   - text: the full original input text (needed to inspect the preceding context).
//   - suggs: the suggestion slice to filter.
//
// Pure function; no I/O. CGo-free; safe to test with CGO_ENABLED=0.
func dropMidSentenceCapitalization(enabled bool, text string, suggs []Suggestion) []Suggestion {
	if !enabled || len(suggs) == 0 {
		return suggs
	}
	out := suggs[:0:len(suggs)] // reuse backing array; avoids alloc when nothing changes
	changed := false
	for _, s := range suggs {
		if isMidSentenceCapMisfire(text, s) {
			changed = true
			// drop: do not append
		} else {
			out = append(out, s)
		}
	}
	if !changed {
		return suggs // return original slice when nothing was filtered
	}
	return out
}

// isMidSentenceCapMisfire returns true when s is a capitalization-only edit
// of an unambiguous function word at a non-sentence-start position.
func isMidSentenceCapMisfire(text string, s Suggestion) bool {
	// 1. The span must be non-empty and within bounds.
	if s.Span.Start < 0 || s.Span.End > len(text) || s.Span.Start >= s.Span.End {
		return false
	}

	orig := text[s.Span.Start:s.Span.End]
	repl := s.Replacement

	// 2. Must be a capitalization-only edit: replacement == orig with only the
	//    first byte uppercased (rest identical). Both must be non-empty.
	if len(orig) == 0 || len(repl) == 0 {
		return false
	}
	// The replacement must be strictly longer than 0 and differ only in first char.
	if len(orig) != len(repl) {
		return false
	}
	// First byte of replacement must be the uppercase of first byte of orig.
	// We use strings.ToUpper on the first rune for full Unicode safety.
	origLower := strings.ToLower(orig)
	if repl != strings.ToUpper(string([]rune(orig)[0]))+string([]rune(orig)[1:]) {
		// Not a simple first-letter capitalization.
		return false
	}
	// Verify the rest is identical (already guaranteed by len check + above, but be explicit).
	if len(orig) > 1 && orig[1:] != repl[1:] {
		return false
	}

	// 3. The lowercased original must be in the function-word stoplist.
	if _, inStoplist := midSentenceCapStoplist[origLower]; !inStoplist {
		return false
	}

	// 4. Must NOT be at a true sentence start.
	if isTrueSentenceStart(text, s.Span.Start) {
		return false
	}

	return true
}

// isTrueSentenceStart returns true when the byte offset pos is at a position
// that legitimately starts a new sentence:
//   - pos == 0 (very start of text), or
//   - the previous non-whitespace character is a sentence-ending punctuation
//     mark (. ! ?), or
//   - the character immediately before pos (after trimming spaces/tabs) is a
//     newline (paragraph break).
func isTrueSentenceStart(text string, pos int) bool {
	if pos == 0 {
		return true
	}
	// Walk backwards from pos-1, skipping spaces and tabs.
	i := pos - 1
	for i >= 0 && (text[i] == ' ' || text[i] == '\t') {
		i--
	}
	if i < 0 {
		// Only whitespace before pos — treat as start.
		return true
	}
	prev := text[i]
	// Newline (paragraph break) counts as sentence start.
	if prev == '\n' || prev == '\r' {
		return true
	}
	// Sentence-ending punctuation.
	return prev == '.' || prev == '!' || prev == '?'
}
