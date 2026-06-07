package ltgrpc

import (
	"context"
	"net"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	pb "github.com/grammarforge/bridge/internal/ltgrpc/pb"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

type fakeSvc struct{ perSentence []correction.Suggestion }

func (f fakeSvc) Correct(_ context.Context, req correction.Request) (correction.Correction, error) {
	return correction.Correction{Original: req.Text, Suggestions: f.perSentence}, nil
}

func dial(t *testing.T, svc CorrectionService) pb.MLServerClient {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	s := grpc.NewServer()
	pb.RegisterMLServerServer(s, NewServer(svc))
	go func() { _ = s.Serve(lis) }()
	t.Cleanup(s.Stop)
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return lis.Dial() }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	return pb.NewMLServerClient(conn)
}

func TestMatchAlignsResponseToSentences(t *testing.T) {
	client := dial(t, fakeSvc{perSentence: []correction.Suggestion{
		{Span: correction.Span{Start: 0, End: 3}, Replacement: "the", Model: correction.ModelHarper, Confidence: 0.9},
	}})
	resp, err := client.Match(context.Background(), &pb.MatchRequest{Sentences: []string{"teh cat", "ok now"}}) //nolint:misspell // "teh" is the test fixture — simulates a typo
	require.NoError(t, err)
	require.Len(t, resp.GetSentenceMatches(), 2) // 1:1 with request sentences
	require.Len(t, resp.GetSentenceMatches()[0].GetMatches(), 1)
}
