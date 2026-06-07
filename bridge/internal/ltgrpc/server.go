package ltgrpc

import (
	"context"

	"github.com/grammarforge/bridge/internal/correction"
	pb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
)

// CorrectionService is the slice of the core the gRPC server needs.
type CorrectionService interface {
	Correct(ctx context.Context, req correction.Request) (correction.Correction, error)
}

// Server implements the generated pb.MLServerServer.
type Server struct {
	pb.UnimplementedMLServerServer
	svc CorrectionService
}

// NewServer binds the gRPC service to the correction core.
func NewServer(svc CorrectionService) *Server { return &Server{svc: svc} }

// Match runs each sentence through the correction service and returns a
// MatchResponse aligned 1:1 with the request sentences (LT requires this).
func (s *Server) Match(ctx context.Context, req *pb.MatchRequest) (*pb.MatchResponse, error) {
	resp := &pb.MatchResponse{}
	for _, sentence := range req.GetSentences() {
		c, err := s.svc.Correct(ctx, correction.Request{Text: sentence})
		if err != nil {
			resp.SentenceMatches = append(resp.SentenceMatches, &pb.MatchList{}) // empty, keep alignment
			continue
		}
		resp.SentenceMatches = append(resp.SentenceMatches, suggestionsToMatchList(c.Suggestions))
	}
	return resp, nil
}
