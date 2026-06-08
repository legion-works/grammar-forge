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

// PersonalizationExamples must group accepted pairs (most-recent-first, capped)
// and rejected pairs (count >= 3, most-frequent-first, capped). The query is
// the data source for the prompt-cache few-shot block (SPEC §5.5).
func TestPersonalizationExamplesGroupsAcceptedAndRejected(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Seed 3 distinct accepted pairs (a/b, c/d, e/f) each logged once with
	// signal='accepted'. Insertion order is a/b first, then c/d, then e/f
	// last. "Most recent first" means e/f first.
	mkAccepted := func(orig, sug string) {
		id, err := s.LogCorrection(ctx, correction.Event{Original: orig, Suggestion: sug, Model: correction.ModelLLM})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, id, correction.SignalAccepted))
	}
	mkAccepted("a", "b")
	mkAccepted("c", "d")
	mkAccepted("e", "f")

	// Rejected pair "x"/"y" logged 3 times -> appears.
	mkRejected := func(orig, sug string) {
		id, err := s.LogCorrection(ctx, correction.Event{Original: orig, Suggestion: sug, Model: correction.ModelLLM})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, id, correction.SignalRejected))
	}
	for i := 0; i < 3; i++ {
		mkRejected("x", "y")
	}

	// Rejected pair "u"/"v" logged 2 times -> does NOT appear (threshold is 3).
	for i := 0; i < 2; i++ {
		mkRejected("u", "v")
	}

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "e", Suggestion: "f", Count: 1},
		{Original: "c", Suggestion: "d", Count: 1},
		{Original: "a", Suggestion: "b", Count: 1},
	}, got.Accepted, "accepted pairs in most-recent-first order (e/f last inserted = most recent)")
	require.Equal(t, []correction.EditPair{
		{Original: "x", Suggestion: "y", Count: 3},
	}, got.Rejected, "rejected pairs with count >= 3 only")
}

// Empty log -> empty PersonalizationData. No rows, no error.
func TestPersonalizationExamplesEmpty(t *testing.T) {
	s := newTestStore(t)
	got, err := s.PersonalizationExamples(context.Background())
	require.NoError(t, err)
	require.Empty(t, got.Accepted)
	require.Empty(t, got.Rejected)
}

// Rows with signal=NULL (no user reaction yet) must NOT appear in either set.
// Only explicit 'accepted' / 'rejected' feed the few-shot block.
func TestPersonalizationExamplesIgnoresSignallessRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Log two corrections, only one gets a signal.
	id1, err := s.LogCorrection(ctx, correction.Event{Original: "p", Suggestion: "q", Model: correction.ModelLLM})
	require.NoError(t, err)
	_, err = s.LogCorrection(ctx, correction.Event{Original: "r", Suggestion: "s", Model: correction.ModelLLM})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, id1, correction.SignalAccepted))

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "p", Suggestion: "q", Count: 1},
	}, got.Accepted)
	require.Empty(t, got.Rejected)
}

// Rejected pairs must be ordered by RECENCY (MAX(ts) DESC, MAX(id) DESC),
// not by frequency. An old pair with a high rejection count must NOT
// crowd out a recent pair at the threshold. Mirrors the Accepted-query
// ordering so the few-shot block reflects the user's latest preferences
// (the most useful signal for personalisation), not the loudest.
func TestPersonalizationExamplesRejectedOrderByRecency(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// Helper: log a rejected event.
	reject := func(orig, sug string) {
		id, err := s.LogCorrection(ctx, correction.Event{Original: orig, Suggestion: sug, Model: correction.ModelLLM})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, id, correction.SignalRejected))
	}

	// OLD pair with HIGH count (5x) — under the old ORDER BY c DESC this
	// would have come first. Under recency ordering it must come LAST.
	for i := 0; i < 5; i++ {
		reject("old", "high-count")
	}
	// NEWER pair at the threshold (3x) — under recency ordering this
	// comes FIRST.
	for i := 0; i < 3; i++ {
		reject("new", "threshold")
	}

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "new", Suggestion: "threshold", Count: 3},
		{Original: "old", Suggestion: "high-count", Count: 5},
	}, got.Rejected,
		"rejected pairs must be ordered by recency (most-recent first), not by count — the newer threshold-count pair must come BEFORE the older high-count pair")
}
