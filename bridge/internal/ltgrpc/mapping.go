// Package ltgrpc implements LanguageTool's RemoteRule MLServer gRPC service,
// mapping the bridge's corrections into LT Match messages.
package ltgrpc

import (
	"strings"
	"unicode/utf8"

	"github.com/grammarforge/bridge/internal/correction"
	pb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
)

// suggestionToMatch converts one suggestion to an LT Match against sentence
// (the suggestion's byte offsets are relative to sentence).
//
// Two LT GRPCRule invariants are enforced here:
//
//  1. Non-empty description. LT throws "Missing message for match with ID <id>"
//     (tripping the RemoteRule circuit breaker, dropping ALL of the bridge's
//     matches) when the description is empty. Only the Harper path sets
//     Suggestion.Message; LLM/GECToR leave it blank, so default per-model.
//  2. Non-zero length (fromPos < toPos). The bridge models a pure INSERTION as a
//     zero-length span (Start == End) with a non-empty Replacement (e.g.
//     correcting a transposed-letter typo by inserting a single character). LT
//     rejects fromPos == toPos with "fromPos (N) must be less than toPos (N)"
//     (also circuit-breaker fatal). So widen an insertion to cover one adjacent
//     UTF-8 character and fold that character into the replacement, producing an
//     identical applied result.
func suggestionToMatch(sentence string, s correction.Suggestion) *pb.Match {
	description := s.Message
	if description == "" {
		description = matchDescriptionFor(s.Model)
	}

	offset, length, replacement := s.Span.Start, s.Span.End-s.Span.Start, s.Replacement
	candidates := s.Replacements
	if len(candidates) == 0 {
		candidates = []string{s.Replacement}
	}
	widened := false
	if length == 0 {
		offset, length, replacement = widenInsertion(sentence, s.Span.Start, s.Replacement)
		widened = true
	}
	reps := make([]*pb.SuggestedReplacement, 0, len(candidates))
	for i, cand := range candidates {
		r := cand
		if widened {
			if i == 0 {
				r = replacement // already anchored by widenInsertion above
			} else {
				_, _, r = widenInsertion(sentence, s.Span.Start, cand)
			}
		}
		reps = append(reps, &pb.SuggestedReplacement{Replacement: r, Confidence: float32(s.Confidence)})
	}

	return &pb.Match{
		Offset:                uint32(offset),
		Length:                uint32(length),
		Id:                    "GF_" + strings.ToUpper(string(s.Model)),
		SubId:                 s.RuleID,
		SuggestedReplacements: reps,
		// RuleDescription and MatchDescription are both populated: LT's GRPCRule
		// validates the match description, and a non-empty rule description keeps
		// the add-on/UI label sensible.
		RuleDescription:  description,
		MatchDescription: description,
		// Rule.IsPremium: every bridge-emitted match is a GrammarForge premium
		// feature, so the Rule object carries IsPremium=true. This is what LT's
		// /v2/check JSON surfaces to clients (the upstream LT browser add-on is
		// closed-source and gates on the premium flag).
		Rule: &pb.Rule{IsPremium: true},
	}
}

// widenInsertion converts a zero-length insertion of `repl` at byte position
// `at` into an equivalent non-zero-length (offset, length, replacement) for LT.
// It anchors on the UTF-8 character immediately to the LEFT (folding it into the
// replacement), or to the RIGHT when the insertion is at the start of the text.
// Applying the returned (offset, length, replacement) to the text yields exactly
// the same string as inserting `repl` at `at`.
func widenInsertion(text string, at int, repl string) (offset, length int, replacement string) {
	if at > 0 && at <= len(text) {
		// anchor on the rune ending at `at` (step back to its start)
		start := at - 1
		for start > 0 && !utf8.RuneStart(text[start]) {
			start--
		}
		anchor := text[start:at]
		return start, at - start, anchor + repl
	}
	if at == 0 && len(text) > 0 {
		// no char to the left: anchor on the first rune
		_, size := utf8.DecodeRuneInString(text)
		anchor := text[:size]
		return 0, size, repl + anchor
	}
	// empty text (or out-of-range): nothing to anchor on. Leave as-is; the
	// caller's Span.Validate path / LT will treat it as a no-op. This is
	// unreachable for real corrections (an insertion implies surrounding text).
	return at, 0, repl
}

// matchDescriptionFor returns a human-readable, non-empty fallback description
// for a suggestion whose Message is empty (LLM / GECToR paths).
func matchDescriptionFor(model correction.Model) string {
	switch model {
	case correction.ModelLLM:
		return "GrammarForge (AI suggestion)"
	case correction.ModelGECToR:
		return "GrammarForge (grammar)"
	case correction.ModelHarper:
		return "GrammarForge (spelling/style)"
	default:
		return "GrammarForge suggestion"
	}
}

func suggestionsToMatchList(sentence string, sugs []correction.Suggestion) *pb.MatchList {
	ml := &pb.MatchList{}
	for _, s := range sugs {
		ml.Matches = append(ml.Matches, suggestionToMatch(sentence, s))
	}
	return ml
}
