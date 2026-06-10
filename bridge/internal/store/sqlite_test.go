package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

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

	id, _, err := s.LogCorrection(ctx, correction.Event{
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
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Original: "a", Suggestion: "b", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{Original: "a", Replacement: "b", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
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
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: orig, Suggestion: sug, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{Original: orig, Replacement: sug, Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
	}
	mkAccepted("a", "b")
	mkAccepted("c", "d")
	mkAccepted("e", "f")

	// Rejected pair "x"/"y" logged 3 times -> appears.
	mkRejected := func(orig, sug string) {
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: orig, Suggestion: sug, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{Original: orig, Replacement: sug, Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalRejected))
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
	_, id1, err := s.LogCorrection(ctx, correction.Event{
		Original: "p", Suggestion: "q", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{Original: "p", Replacement: "q", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	_, _, err = s.LogCorrection(ctx, correction.Event{
		Original: "r", Suggestion: "s", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{Original: "r", Replacement: "s", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, id1[0], correction.SignalAccepted))

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
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: orig, Suggestion: sug, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{Original: orig, Replacement: sug, Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalRejected))
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

func TestOpenEnablesWALAndBusyTimeout(t *testing.T) {
	s := newTestStore(t)
	var mode string
	require.NoError(t, s.db.QueryRow(`PRAGMA journal_mode`).Scan(&mode))
	require.Equal(t, "wal", mode)
	var timeout int
	require.NoError(t, s.db.QueryRow(`PRAGMA busy_timeout`).Scan(&timeout))
	require.Equal(t, 5000, timeout)
}

func TestPruneOlderThanKeepsSignaledRows(t *testing.T) {
	s := newTestStore(t)
	// Old row WITH a signal (must survive — it is training data).
	_, keepIDs, err := s.LogCorrection(context.Background(), correction.Event{
		Source: "browser", Original: "keep", Suggestion: "kept", Model: "llm",
		Edits: []correction.EditRecord{{Original: "keep", Replacement: "kept", Model: "llm"}},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(context.Background(), keepIDs[0], correction.SignalAccepted))
	// Old row WITHOUT a signal (must be pruned).
	_, _, err = s.LogCorrection(context.Background(), correction.Event{
		Source: "browser", Original: "drop", Suggestion: "dropped", Model: "llm",
		Edits: []correction.EditRecord{{Original: "drop", Replacement: "dropped", Model: "llm"}},
	})
	require.NoError(t, err)
	// Backdate both corrections 100 days.
	cut := time.Now().AddDate(0, 0, -100).UnixMilli()
	_, err = s.db.Exec(`UPDATE corrections SET ts = ?`, cut)
	require.NoError(t, err)

	require.NoError(t, s.PruneOlderThan(90))
	n, err := s.CountCorrections(context.Background())
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
	var edits int
	require.NoError(t, s.db.QueryRow(`SELECT COUNT(*) FROM edits`).Scan(&edits))
	require.Equal(t, 1, edits, "orphaned edits of pruned corrections must go too")
}

func TestLogCorrectionInsertsEditsAndReturnsIDs(t *testing.T) {
	s := newTestStore(t)
	id, editIDs, err := s.LogCorrection(context.Background(), correction.Event{
		Source: "browser", Original: "I has teh cat", Suggestion: "I have the cat", Model: "llm", //nolint:misspell // intentional fixture
		Edits: []correction.EditRecord{
			{SpanStart: 2, SpanEnd: 5, Original: "has", Replacement: "have", Model: "llm", Confidence: 0.9},
			{SpanStart: 6, SpanEnd: 9, Original: "teh", Replacement: "the", Model: "harper", Category: "spelling"}, //nolint:misspell // intentional fixture
		},
	})
	require.NoError(t, err)
	require.Positive(t, id)
	require.Len(t, editIDs, 2)
	require.NotEqual(t, editIDs[0], editIDs[1])
}

func TestLogSignalAttributesToOneEdit(t *testing.T) {
	s := newTestStore(t)
	_, editIDs, err := s.LogCorrection(context.Background(), correction.Event{
		Source: "browser", Original: "x", Suggestion: "y", Model: "llm",
		Edits: []correction.EditRecord{
			{Original: "colour", Replacement: "color", Model: "llm"},
			{Original: "teh", Replacement: "the", Model: "llm"}, //nolint:misspell // intentional fixture
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(context.Background(), editIDs[0], correction.SignalAccepted))
	data, err := s.PersonalizationExamples(context.Background())
	require.NoError(t, err)
	require.Len(t, data.Accepted, 1)
	require.Equal(t, "colour", data.Accepted[0].Original)
	require.Equal(t, "color", data.Accepted[0].Suggestion)
}

func TestPersonalizationNegativePoolCountsIgnored(t *testing.T) {
	s := newTestStore(t)
	for i := 0; i < 3; i++ {
		_, editIDs, err := s.LogCorrection(context.Background(), correction.Event{
			Source: "browser", Original: "x", Suggestion: "y", Model: "llm",
			Edits: []correction.EditRecord{{Original: "grey", Replacement: "gray", Model: "llm"}},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(context.Background(), editIDs[0], correction.SignalIgnored))
	}
	data, err := s.PersonalizationExamples(context.Background())
	require.NoError(t, err)
	require.Len(t, data.Rejected, 1, "3x ignored of the same edit pair is a negative pattern")
	require.Equal(t, "grey", data.Rejected[0].Original)
	require.Equal(t, 3, data.Rejected[0].Count)
}
