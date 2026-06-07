package store

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

func newTestStore(t *testing.T) *SQLite {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestLogCorrectionAndCount(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	require.Equal(t, int64(0), mustCount(t, s))

	id, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "I has a cat",
		Suggestion: "I have a cat", Model: correction.ModelLLM, BaseModel: "grmr",
	})
	require.NoError(t, err)
	require.Greater(t, id, int64(0))
	require.Equal(t, int64(1), mustCount(t, s))
}

func TestLogSignalUpdatesRow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	id, err := s.LogCorrection(ctx, correction.Event{Original: "a", Suggestion: "b", Model: correction.ModelLLM})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, id, correction.SignalAccepted))
	require.NoError(t, s.LogSignal(ctx, 99999, correction.SignalRejected)) // missing id: no error, no-op
}

func mustCount(t *testing.T, s *SQLite) int64 {
	t.Helper()
	n, err := s.CountCorrections(context.Background())
	require.NoError(t, err)
	return n
}
