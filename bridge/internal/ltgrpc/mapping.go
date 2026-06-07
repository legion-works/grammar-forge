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
func suggestionToMatch(s correction.Suggestion) *pb.Match {
	return &pb.Match{
		Offset: uint32(s.Span.Start),
		Length: uint32(s.Span.End - s.Span.Start),
		Id:     "GF_" + strings.ToUpper(string(s.Model)),
		SubId:  s.RuleID,
		SuggestedReplacements: []*pb.SuggestedReplacement{
			{Replacement: s.Replacement, Confidence: float32(s.Confidence)},
		},
		MatchDescription: s.Message,
	}
}

func suggestionsToMatchList(sugs []correction.Suggestion) *pb.MatchList {
	ml := &pb.MatchList{}
	for _, s := range sugs {
		ml.Matches = append(ml.Matches, suggestionToMatch(s))
	}
	return ml
}
