// Package ltgrpc implements LanguageTool's RemoteRule MLServer gRPC service,
// mapping the bridge's corrections into LT Match messages.
package ltgrpc

import (
	"strings"

	"github.com/grammarforge/bridge/internal/correction"
	pb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
)

// suggestionToMatch converts one suggestion to an LT Match. Offsets are assumed
// sentence-relative (the caller passes sentence-local suggestions).
//
// LT's GRPCRule REQUIRES a non-empty match description, throwing
// "Missing message for match with ID <id>" (which trips the RemoteRule circuit
// breaker and drops ALL of the bridge's matches) when it is empty. Only the
// Harper path sets Suggestion.Message; LLM and GECToR suggestions leave it
// blank. So default the description to a per-model label when Message is empty.
func suggestionToMatch(s correction.Suggestion) *pb.Match {
	description := s.Message
	if description == "" {
		description = matchDescriptionFor(s.Model)
	}
	return &pb.Match{
		Offset: uint32(s.Span.Start),
		Length: uint32(s.Span.End - s.Span.Start),
		Id:     "GF_" + strings.ToUpper(string(s.Model)),
		SubId:  s.RuleID,
		SuggestedReplacements: []*pb.SuggestedReplacement{
			{Replacement: s.Replacement, Confidence: float32(s.Confidence)},
		},
		// RuleDescription and MatchDescription are both populated: LT's GRPCRule
		// validates the match description, and a non-empty rule description keeps
		// the add-on/UI label sensible.
		RuleDescription:  description,
		MatchDescription: description,
	}
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

func suggestionsToMatchList(sugs []correction.Suggestion) *pb.MatchList {
	ml := &pb.MatchList{}
	for _, s := range sugs {
		ml.Matches = append(ml.Matches, suggestionToMatch(s))
	}
	return ml
}
