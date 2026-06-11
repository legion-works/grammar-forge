package correction

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// This file implements the LLM over-edit repair framework (spec:
// .opencode/specs/2026-06-10-overedit-filter-design.md). Each OverEditRule
// repairs ONE measured class of LLM over-edit by reverting the over-edited
// region of the LLM output toward the original text BEFORE the diff is
// computed. Text-level (not suggestion-level) repair is load-bearing: the
// diff can fuse a wanted edit (capitalization) and an unwanted one (comma
// restructure) into a single suggestion, so dropping suggestions after the
// diff provably loses wanted edits (verified live on golden case 91).
//
// Rules are pure string functions: no I/O, no errors. A rule that finds no
// over-edit returns corrected unchanged. The repaired text is always
// re-diffed against the original, so spans stay canonical by construction.

// OverEditRule repairs one class of LLM over-edit: it returns corrected with
// the over-edit reverted toward original, or corrected unchanged.
type OverEditRule func(original, corrected string) string

// pluralToSingularVerb maps the plural verb forms whose singular flip the
// proximity-agreement rule guards against. Only plural->singular flips are
// over-edit candidates: singular->plural is the direction of genuine
// agreement FIXES (golden 4, 5, 10) and is never touched.
var pluralToSingularVerb = map[string]string{
	"were": "was",
	"are":  "is",
	"have": "has",
	"do":   "does",
}

// RepairProximityAgreementFlip reverts a plural->singular verb flip that
// breaks correct nor/or proximity agreement ("Neither the manager nor the
// employees WERE..." — the verb agrees with the NEAREST conjunct). The LLM
// "fixes" such verbs to the singular (golden case 118's class). Guards:
//   - Guard A: the original has a whole-TOKEN "nor" or "or" before the verb.
//     Token match, not substring — "Neither" contains "or", and the wanted
//     fix "Neither of the answers were->was" (golden 70) must not trigger.
//   - Guard B: the token immediately before the verb in the original is
//     plural-looking (see isPluralLookingNoun) — when the nearest conjunct
//     is singular the flip is a genuine fix and survives.
func RepairProximityAgreementFlip(original, corrected string) string {
	if original == corrected {
		return corrected
	}
	origTokens := tokenizeWords(original)
	corrTokens := tokenizeWords(corrected)
	matches := alignTokens(origTokens, corrTokens)

	type splice struct {
		start, end int
		text       string
	}
	var splices []splice
	for _, sub := range tokenSubstitutions(origTokens, corrTokens, matches) {
		origToken := origTokens[sub.origIndex]
		corrToken := corrTokens[sub.corrIndex]
		origCore, origTail := splitTrailingPunctuation(origToken.text)
		corrCore, corrTail := splitTrailingPunctuation(corrToken.text)
		if origTail != corrTail {
			continue // the edit changed punctuation too — not a bare flip
		}
		singular, isPluralVerb := pluralToSingularVerb[strings.ToLower(origCore)]
		if !isPluralVerb || !strings.EqualFold(corrCore, singular) {
			continue
		}
		if !hasNorOrTokenBefore(origTokens, sub.origIndex) {
			continue // Guard A
		}
		if sub.origIndex == 0 || !isPluralLookingNoun(origTokens[sub.origIndex-1].text) {
			continue // Guard B
		}
		splices = append(splices, splice{
			start: corrToken.start,
			end:   corrToken.start + len(corrToken.text),
			text:  origToken.text,
		})
	}

	// Apply last-to-first so earlier byte offsets stay valid.
	out := corrected
	for i := len(splices) - 1; i >= 0; i-- {
		sp := splices[i]
		out = out[:sp.start] + sp.text + out[sp.end:]
	}
	return out
}

// wordToken is one whitespace-delimited token with its byte offset.
type wordToken struct {
	text  string
	start int
}

// tokenizeWords splits s into whitespace-delimited tokens with byte offsets.
// Punctuation stays attached to its word ("were." is one token).
func tokenizeWords(s string) []wordToken {
	var tokens []wordToken
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if unicode.IsSpace(r) {
			i += size
			continue
		}
		start := i
		for i < len(s) {
			next, nextSize := utf8.DecodeRuneInString(s[i:])
			if unicode.IsSpace(next) {
				break
			}
			i += nextSize
		}
		tokens = append(tokens, wordToken{text: s[start:i], start: start})
	}
	return tokens
}

// alignTokens returns the (origIndex, corrIndex) pairs of the leftmost
// common subsequence of exact-equal tokens: for each orig token (in order),
// pair it with the earliest matching corr token after the previous match.
// O(n+m) — the leftmost match per orig index gives well-spaced 1:1 gaps so
// tokenSubstitutions can detect bare token-for-token edits. A standard
// longest-common-subsequence reconstruction is NOT used: when a token
// appears more than once on one side (e.g. "in" twice in the orig of
// "neither... were in paris in france.") the LCS tiebreak picks the later
// match, which fuses the surrounding edits into one unbalanced gap and
// hides the bare verb flip the rule is looking for. Greedy leftmost pairing
// keeps the gaps 1:1 in that case and still finds a valid common
// subsequence for every other case the rule handles. Escalated inputs are
// short (EscalationPolicy.MaxSentenceLen caps sentence length).
func alignTokens(orig, corr []wordToken) [][2]int {
	positions := make(map[string][]int, len(corr))
	for j, t := range corr {
		positions[t.text] = append(positions[t.text], j)
	}
	var pairs [][2]int
	lastJ := -1
	for i, t := range orig {
		for _, j := range positions[t.text] {
			if j > lastJ {
				pairs = append(pairs, [2]int{i, j})
				lastJ = j
				break
			}
		}
	}
	return pairs
}

// tokenSubstitution is a 1:1 token replacement between original and corrected.
type tokenSubstitution struct {
	origIndex, corrIndex int
}

// tokenSubstitutions extracts positionally paired substitutions from a token
// alignment: a gap between consecutive matches that skips the SAME number of
// tokens on each side pairs them index-wise (so a verb flip next to another
// 1:1 edit — e.g. an adjacent spelling fix — is still found). Unbalanced gaps
// (insertions, deletions, multi-token rewrites) are ignored — this rule only
// handles bare token-for-token flips.
func tokenSubstitutions(orig, corr []wordToken, matches [][2]int) []tokenSubstitution {
	var subs []tokenSubstitution
	appendPairwise := func(origFrom, origTo, corrFrom, corrTo int) {
		if origTo-origFrom != corrTo-corrFrom {
			return // unbalanced gap — not token-for-token substitutions
		}
		for k := 0; origFrom+k < origTo; k++ {
			subs = append(subs, tokenSubstitution{origIndex: origFrom + k, corrIndex: corrFrom + k})
		}
	}
	prevOrig, prevCorr := -1, -1
	for _, m := range matches {
		appendPairwise(prevOrig+1, m[0], prevCorr+1, m[1])
		prevOrig, prevCorr = m[0], m[1]
	}
	appendPairwise(prevOrig+1, len(orig), prevCorr+1, len(corr))
	return subs
}

// splitTrailingPunctuation splits a token into its core (everything up to the
// last letter/digit) and the trailing punctuation tail ("were." -> "were", ".").
func splitTrailingPunctuation(s string) (core, tail string) {
	core = strings.TrimRightFunc(s, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	return core, s[len(core):]
}

// hasNorOrTokenBefore reports whether a whole token "nor" or "or"
// (case-insensitive, trailing punctuation ignored) appears before verbIndex.
func hasNorOrTokenBefore(tokens []wordToken, verbIndex int) bool {
	for k := 0; k < verbIndex; k++ {
		core, _ := splitTrailingPunctuation(tokens[k].text)
		switch strings.ToLower(core) {
		case "nor", "or":
			return true
		}
	}
	return false
}

// isPluralLookingNoun reports whether a token looks like a plural noun:
// alphabetic core of >= 3 runes ending in "s" but not "ss" (boss) and not
// a possessive "'s" (manager's). Deliberately crude — the rule it guards
// only fires on an LLM plural->singular flip after a nor/or conjunction,
// so a false negative just means the LLM's edit is kept.
func isPluralLookingNoun(token string) bool {
	core, _ := splitTrailingPunctuation(token)
	core = strings.ToLower(core)
	if utf8.RuneCountInString(core) < 3 || !strings.HasSuffix(core, "s") {
		return false
	}
	if strings.HasSuffix(core, "ss") || strings.HasSuffix(core, "'s") {
		return false
	}
	for _, r := range core {
		if !unicode.IsLetter(r) && r != '\'' {
			return false
		}
	}
	return true
}

// properNounCommaPattern matches "X, Y" (optionally "X, Y,") where X and Y
// are capitalized words — the shape the LLM produces when it restructures
// "x <prep> y" into a geographic appositive ("Paris, France,").
var properNounCommaPattern = regexp.MustCompile(`(\p{Lu}\p{Ll}+), (\p{Lu}\p{Ll}+)(,?)`)

// commaRestorePreps are the prepositions the comma-restore rule recognises in
// the original. Small and literal on purpose: the rule must only fire when
// the LLM itself converted a preposition into a comma.
var commaRestorePreps = []string{"in", "at", "of", "on"}

// RepairProperNounCommaRestructure reverts the LLM's "x <prep> y" ->
// "X, Y[,]" proper-noun restructure (golden case 91's class). For each
// capitalized "X, Y[,]" pair in corrected, if the ORIGINAL contains
// "x <prep> y" as whole words (case-insensitive), the corrected region is
// rewritten to "X <prep> Y" — keeping corrected's casing (the wanted
// capitalization edit survives) and restoring the trailing punctuation the
// original had after y (the inserted comma is dropped when the original had
// none). Genuine appositives are safe: an original already written as
// "x, y" has no preposition form, so the rule never fires on it.
func RepairProperNounCommaRestructure(original, corrected string) string {
	return properNounCommaPattern.ReplaceAllStringFunc(corrected, func(match string) string {
		sub := properNounCommaPattern.FindStringSubmatch(match)
		x, y := sub[1], sub[2]
		prep, end := findPrepositionForm(original, x, y)
		if prep == "" {
			return match
		}
		restored := x + " " + prep + " " + y
		if end < len(original) && original[end] == ',' {
			restored += ","
		}
		return restored
	})
}

// findPrepositionForm searches original case-insensitively for "x <prep> y"
// as whole words and returns the matched preposition and the byte offset just
// past the match, or ("", -1) when no preposition form exists.
func findPrepositionForm(original, x, y string) (prep string, end int) {
	lowerOriginal := strings.ToLower(original)
	for _, p := range commaRestorePreps {
		needle := strings.ToLower(x) + " " + p + " " + strings.ToLower(y)
		for from := 0; ; {
			i := strings.Index(lowerOriginal[from:], needle)
			if i < 0 {
				break
			}
			i += from
			if isWordBoundedAt(lowerOriginal, i, i+len(needle)) {
				return p, i + len(needle)
			}
			from = i + 1
		}
	}
	return "", -1
}

// isWordBoundedAt reports whether s[start:end] is bounded by non-word runes
// (or the string edges) on both sides.
func isWordBoundedAt(s string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(s[:start])
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	if end < len(s) {
		r, _ := utf8.DecodeRuneInString(s[end:])
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// RepairMidWordCaseFlip reverts LLM mid-word case corruption (live-measured
// 2026-06-11 on Gemma-4 QAT, deterministic at temp 0: "auto-detects" ->
// "auto-detectS"). Two guards keep it from over-reaching:
//
//   - Balanced-gap guard: a fold-match pair is a candidate only when the
//     gap BEFORE it and the gap AFTER it are balanced ((i-prevI)==(j-prevJ)
//     and (nextI-i)==(nextJ-j), with the final tail using the token-slice
//     lengths). Unbalanced surroundings mean insertion/deletion churn
//     (e.g. an inserted case-changed duplicate at corr[0] when the orig
//     starts at index 0 with a balanced body) — the fold-match is the LLM
//     edit landing in the wrong slot, and we keep the edit (precision-
//     first, consistent with the framework's stance).
//
//   - Direction guard: revert only when EVERY non-initial differing rune
//     is lowercase in original AND uppercase in corrected — the measured
//     Gemma-4 QAT corruption direction. Upper->lower (stuck-caps fixes
//     like "THis"->"This", "IT"->"It") survives. Rune counts must match
//     (EqualFold can match unequal byte lengths, e.g. Kelvin sign U+212A
//     folds to ASCII "k"); the first rune must be byte-identical so the
//     case change lives entirely in non-initial runes; first-rune flips
//     (sentence case "it"->"It", proper nouns "paris"->"Paris") survive.
//
// Alignment is case-insensitive (alignTokensFold), not byte-exact like
// RepairProximityAgreementFlip: byte-exact alignTokens pairs the orig "it"
// with the LATER "it" in a sentence that contains "it" twice (e.g. the
// measured case "it auto-detects ... so it controls ...") and leaves the
// leading sentence-case "It" unaligned, so the "auto-detectS" corruption
// lands in an unbalanced gap with no detected 1:1 substitution. Case-fold
// alignment pairs positionally and lets the per-pair check below catch
// the mid-word flip.
//
// Known accepted trade-off (deliberate, precision-first): a legit
// "iphone"->"iPhone" fix is reverted by this rule — first rune is
// byte-identical, mid-word 'p'/'P' flip is lower->upper (the measured
// direction) and survives both guards. The measured mid-word case
// corruption is high-frequency; iPhone is rare and the reversion is
// recoverable by the user with one extra accept.
func RepairMidWordCaseFlip(original, corrected string) string {
	if original == corrected {
		return corrected
	}
	origTokens := tokenizeWords(original)
	corrTokens := tokenizeWords(corrected)
	matches := alignTokensFold(origTokens, corrTokens)

	type splice struct {
		start, end int
		text       string
	}
	var splices []splice
	prevI, prevJ := -1, -1
	for k, m := range matches {
		i, j := m[0], m[1]
		// Balanced-gap guard: see doc comment.
		if (i - prevI) != (j - prevJ) {
			prevI, prevJ = i, j
			continue
		}
		var nextI, nextJ int
		if k+1 < len(matches) {
			nextI, nextJ = matches[k+1][0], matches[k+1][1]
		} else {
			nextI, nextJ = len(origTokens), len(corrTokens)
		}
		if (nextI - i) != (nextJ - j) {
			prevI, prevJ = i, j
			continue
		}
		prevI, prevJ = i, j

		origToken := origTokens[i]
		corrToken := corrTokens[j]
		origCore, origTail := splitTrailingPunctuation(origToken.text)
		corrCore, corrTail := splitTrailingPunctuation(corrToken.text)
		if origTail != corrTail {
			continue // punctuation also changed — not a bare case flip
		}
		if origCore == corrCore {
			continue // identical cores — no case difference
		}
		if !strings.EqualFold(origCore, corrCore) {
			continue // not a case-only difference
		}
		// EqualFold can match unequal rune counts (e.g. Kelvin sign
		// U+212A folds to ASCII "k", changing byte length). Require
		// identical rune counts so the direction check stays in a
		// sane, rune-parallel regime.
		if utf8.RuneCountInString(origCore) != utf8.RuneCountInString(corrCore) {
			continue
		}
		origRune, origSize := utf8.DecodeRuneInString(origCore)
		corrRune, corrSize := utf8.DecodeRuneInString(corrCore)
		if origSize == 0 || origSize != corrSize || origRune != corrRune {
			continue // empty core, UTF-8 size mismatch, or first rune differs
		}
		// Direction guard: see doc comment. Every non-initial differing
		// rune must be lower in original AND upper in corrected.
		origRunes := []rune(origCore)
		corrRunes := []rune(corrCore)
		allDiffsAreLowerToUpper := true
		for r := 1; r < len(origRunes); r++ {
			if origRunes[r] == corrRunes[r] {
				continue
			}
			if !unicode.IsLower(origRunes[r]) || !unicode.IsUpper(corrRunes[r]) {
				allDiffsAreLowerToUpper = false
				break
			}
		}
		if !allDiffsAreLowerToUpper {
			continue
		}
		splices = append(splices, splice{
			start: corrToken.start,
			end:   corrToken.start + len(corrToken.text),
			text:  origToken.text,
		})
	}

	out := corrected
	for i := len(splices) - 1; i >= 0; i-- {
		sp := splices[i]
		out = out[:sp.start] + sp.text + out[sp.end:]
	}
	return out
}

// alignTokensFold returns leftmost-match (origIndex, corrIndex) pairs using
// case-insensitive token comparison (strings.ToLower). The same leftmost-
// match rule applies: for each orig token (in order), pair it with the
// earliest matching corr token after the previous match. Used by rules
// whose semantics are case-insensitive (mid-word case flip revert) —
// byte-exact alignTokens would pair "it" with the LATER "it" in a sentence
// that contains "it" twice and miss the leading sentence-case "It".
func alignTokensFold(orig, corr []wordToken) [][2]int {
	positions := make(map[string][]int, len(corr))
	for j, t := range corr {
		key := strings.ToLower(t.text)
		positions[key] = append(positions[key], j)
	}
	var pairs [][2]int
	lastJ := -1
	for i, t := range orig {
		key := strings.ToLower(t.text)
		for _, j := range positions[key] {
			if j > lastJ {
				pairs = append(pairs, [2]int{i, j})
				lastJ = j
				break
			}
		}
	}
	return pairs
}

// DefaultOverEditRules returns the over-edit repair chain wired by main when
// GF_OVEREDIT_FILTER is enabled (the default). Rules are registered
// explicitly — one entry per measured over-edit class.
func DefaultOverEditRules() []OverEditRule {
	return []OverEditRule{
		RepairProximityAgreementFlip,
		RepairProperNounCommaRestructure,
		RepairMidWordCaseFlip,
	}
}
