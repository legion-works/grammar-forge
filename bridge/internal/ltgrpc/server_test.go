package ltgrpc

import (
	"context"
	"errors"
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

// errSvc returns suggestions for the first sentence, none for the second,
// and an error for the third. Used to prove the server preserves strict 1:1
// alignment in MatchResponse even when the per-sentence backend results
// vary (empty / errored).
type errSvc struct{}

func (errSvc) Correct(_ context.Context, req correction.Request) (correction.Correction, error) {
	switch req.Text {
	case "first":
		return correction.Correction{
			Original: req.Text,
			Suggestions: []correction.Suggestion{
				{Span: correction.Span{Start: 0, End: 3}, Replacement: "the", Model: correction.ModelHarper, Confidence: 0.9},
			},
		}, nil
	case "second":
		return correction.Correction{Original: req.Text, Suggestions: nil}, nil
	case "third":
		return correction.Correction{}, errors.New("backend down")
	default:
		return correction.Correction{Original: req.Text}, nil
	}
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

func TestMatchStrictOneToOneAlignmentWithMixedResults(t *testing.T) {
	client := dial(t, errSvc{})
	resp, err := client.Match(context.Background(), &pb.MatchRequest{
		Sentences: []string{"first", "second", "third"},
	})
	require.NoError(t, err)
	require.Len(t, resp.GetSentenceMatches(), 3, "strict 1:1 with request sentences")
	got := []int{
		len(resp.GetSentenceMatches()[0].GetMatches()),
		len(resp.GetSentenceMatches()[1].GetMatches()),
		len(resp.GetSentenceMatches()[2].GetMatches()),
	}
	require.Equal(t, []int{1, 0, 0}, got, "per-sentence match counts: [1 hit, 0 clean, 0 errored]")

	// The errored sentence must still produce a non-nil empty MatchList,
	// not a nil/dropped entry — LT indexes by position.
	require.NotNil(t, resp.GetSentenceMatches()[2])
	require.Empty(t, resp.GetSentenceMatches()[2].GetMatches())
}
