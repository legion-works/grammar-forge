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

// TestLogTone: tone_signals table exists, inserts a row with the JSON tag
// array, and round-trips Source. Best-effort signal log: errors must surface
// to the caller (the service swallows them so /tone never fails).
func TestLogTone(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	require.NoError(t, s.LogTone(ctx, correction.ToneEvent{
		TextHash: "abc123",
		Tags: []correction.ToneTag{
			{Tag: "frustrated", Confidence: 0.8},
			{Tag: "direct", Confidence: 0.5},
		},
		Target: "polite",
		Source: correction.SourceVencord,
	}))
	var n int
	require.NoError(t, s.db.QueryRow(`SELECT COUNT(*) FROM tone_signals`).Scan(&n))
	require.Equal(t, 1, n)
	var textHash, tagsJSON, source string
	require.NoError(t, s.db.QueryRow(
		`SELECT text_hash, tags_json, source FROM tone_signals ORDER BY id DESC LIMIT 1`,
	).Scan(&textHash, &tagsJSON, &source))
	require.Equal(t, "abc123", textHash)
	require.Contains(t, tagsJSON, `"frustrated"`)
	require.Contains(t, tagsJSON, `"direct"`)
	require.Equal(t, string(correction.SourceVencord), source)
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
	// last. "Most recent first" means e/f first. Spans cover the whole
	// single-char parent (SpanStart=0, SpanEnd=1) so the word-boundary
	// widening in the store produces pairOriginal == parent and
	// pairSuggestion == replacement, not a prefix-splice.
	mkAccepted := func(orig, sug string) {
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: orig, Suggestion: sug, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: orig, Replacement: sug, Model: correction.ModelLLM}},
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
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: orig, Replacement: sug, Model: correction.ModelLLM}},
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
	// Log two corrections, only one gets a signal. Spans cover the whole
	// single-char parent so the word-boundary widening reproduces the
	// intended pair verbatim.
	_, id1, err := s.LogCorrection(ctx, correction.Event{
		Original: "p", Suggestion: "q", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "p", Replacement: "q", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	_, _, err = s.LogCorrection(ctx, correction.Event{
		Original: "r", Suggestion: "s", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "r", Replacement: "s", Model: correction.ModelLLM}},
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

	// Helper: log a rejected event. Spans cover the whole parent so the
	// word-boundary widening reproduces the intended pair verbatim.
	reject := func(orig, sug string) {
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: orig, Suggestion: sug, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: len(orig), Original: orig, Replacement: sug, Model: correction.ModelLLM}},
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

// CountSignals aggregates the edits table by signal value for /stats.
// 3 edits logged, 1 accepted + 1 rejected, the third left unsignaled —
// the count is the unit /signal attributes to, NOT the correction.
func TestCountSignalsAggregatesBySignal(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{
			{Original: "a", Replacement: "b", Model: correction.ModelLLM},
			{Original: "c", Replacement: "d", Model: correction.ModelLLM},
			{Original: "e", Replacement: "f", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
	require.NoError(t, s.LogSignal(ctx, editIDs[1], correction.SignalRejected))
	// editIDs[2] intentionally left unsignaled

	got, err := s.CountSignals(ctx)
	require.NoError(t, err)
	require.Equal(t, correction.SignalCounts{
		TotalEdits: 3,
		Accepted:   1,
		Rejected:   1,
		Ignored:    0,
	}, got)
}

// Empty store: all four counts must be exactly zero (no rows, no error).
func TestCountSignalsEmpty(t *testing.T) {
	s := newTestStore(t)
	got, err := s.CountSignals(context.Background())
	require.NoError(t, err)
	require.Equal(t, correction.SignalCounts{}, got)
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
	// Parent text carries the actual word — "I have a colour pencil" — and
	// the edits carry valid spans into it. Spans are required by the word-
	// boundary pair reconstruction (a zero-width span against "x" used to
	// render the raw fragment, but the production behaviour widens to the
	// surrounding word; this test exercises the signal-attribution contract
	// against proper spans).
	_, editIDs, err := s.LogCorrection(context.Background(), correction.Event{
		Source: "browser", Original: "I have a colour pencil", Suggestion: "I have a color pencil", Model: "llm",
		Edits: []correction.EditRecord{
			{SpanStart: 9, SpanEnd: 15, Original: "colour", Replacement: "color", Model: "llm"},
			{SpanStart: 15, SpanEnd: 22, Original: " pencil", Replacement: " pencil", Model: "llm"},
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
	// Parent text is the actual word being edited and the EditRecord carries
	// a valid span (0..4). The word-boundary pair reconstruction in the
	// store widens to (0,4) and the pair is "grey"→"gray".
	for i := 0; i < 3; i++ {
		_, editIDs, err := s.LogCorrection(context.Background(), correction.Event{
			Source: "browser", Original: "grey cat", Suggestion: "gray cat", Model: "llm",
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 4, Original: "grey", Replacement: "gray", Model: "llm"}},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(context.Background(), editIDs[0], correction.SignalIgnored))
	}
	data, err := s.PersonalizationExamples(context.Background())
	require.NoError(t, err)
	require.Len(t, data.Rejected, 1, "3x ignored of the same edit pair is a negative pattern")
	require.Equal(t, "grey", data.Rejected[0].Original)
	require.Equal(t, "gray", data.Rejected[0].Suggestion)
	require.Equal(t, 3, data.Rejected[0].Count)
}

// Production logs edits as SPAN-LEVEL diff fragments (the diff between the
// LLM's rewrite and the original text often returns the changed suffix only —
// "has"→"have" stored as span over the trailing "s" with replacement "ve",
// "a"→"an" stored as "a"→"n", period inserts as ”→'.'). The personalisation
// few-shot block must reconstruct WORD-LEVEL pairs at aggregation time so the
// LLM sees "Correct \"has\" to \"have\"." instead of "Correct \"s\" to \"ve\".".
// Mirrors the production bug that regressed the cold golden eval 125/125
// → 110/125 and caused the LLM to delete @mentions.
func TestPersonalizationExamplesReconstructsWordPairsFromFragments(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Parent sentence is the full input the user typed. The edits carry
	// fragment-level spans: the trailing "s" of "has" (positions 4..5) and
	// the misspelled word at positions 6..9. Both should be widened to the
	// surrounding word and yield "has"→"have" and the misspelling→"the"
	// — NOT the raw fragments.
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "I has teh cat", Suggestion: "I have the cat", Model: correction.ModelLLM, //nolint:misspell // intentional fixture
		Edits: []correction.EditRecord{
			{SpanStart: 2, SpanEnd: 5, Original: "has", Replacement: "have", Model: correction.ModelLLM},
			{SpanStart: 6, SpanEnd: 9, Original: "teh", Replacement: "the", Model: correction.ModelLLM}, //nolint:misspell // intentional fixture
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
	require.NoError(t, s.LogSignal(ctx, editIDs[1], correction.SignalAccepted))

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	// Most-recent-first: the misspelled edit was signaled second, so it leads.
	require.Equal(t, []correction.EditPair{
		{Original: "teh", Suggestion: "the", Count: 1}, //nolint:misspell // intentional fixture
		{Original: "has", Suggestion: "have", Count: 1},
	}, got.Accepted, "fragments must be widened to the surrounding word boundaries, not stored verbatim")
	require.Empty(t, got.Rejected)
}

// A tail-only fragment ("s"→"ve" inside "has") must still widen to the WHOLE
// word "has" and reconstruct "have" — this is the exact shape of the
// production bug.
func TestPersonalizationExamplesReconstructsWordPairFromTailFragment(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Span covers only the trailing "s" of "has" (positions 4..5); the
	// replacement is "ve". After word-boundary expansion the original must
	// be "has" and the suggestion must be "have".
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "I has a cat", Suggestion: "I have a cat", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{
			{SpanStart: 4, SpanEnd: 5, Original: "s", Replacement: "ve", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "has", Suggestion: "have", Count: 1},
	}, got.Accepted, "tail-fragment span must be widened to the containing word and the replacement spliced in")
}

// An out-of-range span (span_end > len(parent.Original) or start>end) is
// unrecoverable: drop the row silently rather than emit a junk pair.
func TestPersonalizationExamplesSkipsInvalidSpan(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Parent Original is "abc" (length 3). The edit's span is [10,20) —
	// far past the end. After word-boundary expansion on a span that's
	// already outside the text, the reconstructed pair would be junk
	// (or an out-of-range slice panic). Drop the row.
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Original: "abc", Suggestion: "abc", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{
			{SpanStart: 10, SpanEnd: 20, Original: "x", Replacement: "y", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Empty(t, got.Accepted, "rows with out-of-range spans must be skipped, not rendered as junk")
	require.Empty(t, got.Rejected)
}

// An edit whose reconstruction produces pairOriginal == pairSuggestion is a
// no-op (e.g. an allowlisted word that survived widening, or a span covering
// a region whose reconstructed text is identical to the original). Drop it
// — feeding the LLM "Correct \"x\" to \"x\"." is junk that biases the model.
func TestPersonalizationExamplesSkipsIdenticalReconstructedPair(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Parent "hello world". Span [6,11) is exactly "world". Replacement
	// "world" is unchanged. After widening the boundaries are already at
	// word edges, so pairOriginal == "world" and pairSuggestion == "world".
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Original: "hello world", Suggestion: "hello world", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{
			{SpanStart: 6, SpanEnd: 11, Original: "world", Replacement: "world", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Empty(t, got.Accepted, "pairs where original==suggestion after reconstruction must be skipped")
}

// Two separate corrections producing the same RECONSTRUCTED word pair must
// collapse to one EditPair with Count=2 — the existing SQL GROUP BY semantics
// move to Go on the reconstructed pair, not on the raw fragment.
func TestPersonalizationExamplesGroupsSameWordPairAcrossCorrections(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	logAccepted := func() {
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: "I has a cat", Suggestion: "I have a cat", Model: correction.ModelLLM,
			Edits: []correction.EditRecord{
				{SpanStart: 2, SpanEnd: 5, Original: "has", Replacement: "have", Model: correction.ModelLLM},
			},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
	}
	logAccepted()
	logAccepted()

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "has", Suggestion: "have", Count: 2},
	}, got.Accepted, "two corrections producing the same reconstructed word pair must collapse to one EditPair with Count=2")
}

// The Count>=3 threshold for the negative pool must apply to the
// RECONSTRUCTED pair, not the raw fragment. Three ignored tail-fragment
// edits of "has"→"have" must yield a single negative pattern.
func TestPersonalizationExamplesRejectedHonorsCountThresholdOnReconstructedPair(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	logIgnored := func() {
		_, editIDs, err := s.LogCorrection(ctx, correction.Event{
			Original: "I has a cat", Suggestion: "I have a cat", Model: correction.ModelLLM,
			Edits: []correction.EditRecord{
				{SpanStart: 4, SpanEnd: 5, Original: "s", Replacement: "ve", Model: correction.ModelLLM},
			},
		})
		require.NoError(t, err)
		require.NoError(t, s.LogSignal(ctx, editIDs[0], correction.SignalIgnored))
	}
	logIgnored()
	logIgnored()
	logIgnored()

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err)
	require.Equal(t, []correction.EditPair{
		{Original: "has", Suggestion: "have", Count: 3},
	}, got.Rejected, "3x ignored of the same reconstructed word pair is a negative pattern")
	require.Empty(t, got.Accepted)
}

// Regression: the edits.signal_ts column is nullable (no NOT NULL
// constraint) and a misbehaving writer (or a partial migration) can
// produce a row with signal set but signal_ts=NULL. The aggregation
// query must NOT error on this row — NULL is treated as the oldest
// possible signal_ts (0) so it falls to the BOTTOM of the recency
// ordering. Without COALESCE the Scan into int64 fails and a single
// stray row breaks the whole few-shot block.
func TestPersonalizationExamplesHandlesNullSignalTS(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	_, editIDs, err := s.LogCorrection(ctx, correction.Event{
		Original: "has", Suggestion: "have", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{
			{SpanStart: 2, SpanEnd: 3, Original: "s", Replacement: "ve", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	// Force the exact shape the bug describes: signal set, signal_ts NULL.
	// Bypasses LogSignal so the timestamp is not auto-stamped.
	_, err = s.db.ExecContext(ctx,
		`UPDATE edits SET signal = 'accepted', signal_ts = NULL WHERE id = ?`,
		editIDs[0])
	require.NoError(t, err)

	got, err := s.PersonalizationExamples(ctx)
	require.NoError(t, err, "NULL signal_ts must not break PersonalizationExamples")
	require.Equal(t, []correction.EditPair{
		{Original: "has", Suggestion: "have", Count: 1},
	}, got.Accepted, "row with NULL signal_ts is treated as oldest (0) and still surfaces the reconstructed pair")
}

// CountStatsExtended powers the retention fields on /stats: per-category edit
// counts (top_issues), consecutive active days (streak), and the
// approximate word count over the last 7 days. The function accepts the
// reference "now" as a parameter so tests can pin the window — the production
// caller passes time.Now() and the test pins to a synthetic date so the
// streak/7d window is deterministic.

// top_issues: every edit's category column is bucketed and the result is
// ordered by count DESC, with category as a stable tiebreak. Empty-string
// category is the default grammar bucket and surfaces as "" in the result —
// the client treats "" as grammar (matches the wire-format category on
// /correct suggestions).
func TestCountStatsExtendedTopIssuesOrdersByCountDesc(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	// Seed edits: 3 spelling, 1 grammar (default empty category), 2 punctuation.
	seed := func(category string) {
		_, _, err := s.LogCorrection(ctx, correction.Event{
			Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{
				SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y",
				Model: correction.ModelLLM, Category: category,
			}},
		})
		require.NoError(t, err)
	}
	for i := 0; i < 3; i++ {
		seed(correction.CategorySpelling)
	}
	seed("") // CategoryGrammar — default
	for i := 0; i < 2; i++ {
		seed(correction.CategoryPunctuation)
	}

	// Pin "now" so the streak/words path doesn't pick up real-time rows.
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, []correction.CategoryCount{
		{Category: correction.CategorySpelling, Count: 3},
		{Category: correction.CategoryPunctuation, Count: 2},
		{Category: correction.CategoryGrammar, Count: 1},
	}, got.TopIssues, "categories ordered by count DESC; empty-string grammar surfaces as \"\"")
}

// streak: consecutive UTC days (calendar days) with at least one correction,
// counted BACKWARD from the supplied `now`. A gap of >=1 day breaks the
// streak. Days in the future relative to `now` are ignored (no future
// activity contributes to "active days"). Seeded by backdating
// corrections.ts directly — the production code path that stamps ts is
// unchanged.
func TestCountStatsExtendedStreakConsecutiveDays(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC) // Monday noon

	// Seed 1 row per day for today, yesterday, and 2 days back. Distinct
	// parent text so LogCorrection inserts 3 distinct corrections.
	backdate := func(daysAgo int) {
		_, _, err := s.LogCorrection(ctx, correction.Event{
			Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y", Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		ts := now.AddDate(0, 0, -daysAgo).UnixMilli()
		_, err = s.db.Exec(`UPDATE corrections SET ts = ? WHERE id = (SELECT MAX(id) FROM corrections)`, ts)
		require.NoError(t, err)
	}
	backdate(0) // today
	backdate(1) // yesterday
	backdate(2) // 2 days back

	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, 3, got.Streak, "3 consecutive days ending today = streak 3")
}

// streak: a gap of >=1 day breaks the streak; the count restarts from the
// most-recent active day and is bounded by that chain.
func TestCountStatsExtendedStreakBreaksOnGap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	backdate := func(daysAgo int) {
		_, _, err := s.LogCorrection(ctx, correction.Event{
			Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y", Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		ts := now.AddDate(0, 0, -daysAgo).UnixMilli()
		_, err = s.db.Exec(`UPDATE corrections SET ts = ? WHERE id = (SELECT MAX(id) FROM corrections)`, ts)
		require.NoError(t, err)
	}
	// Active: today, yesterday. Then 5-day gap. Then a 3-day chain (days
	// 7, 8, 9 back). The most-recent chain is 2 (today + yesterday) — the
	// older 3-day chain must NOT count because it doesn't end at today.
	backdate(0)
	backdate(1)
	backdate(7)
	backdate(8)
	backdate(9)

	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, 2, got.Streak, "gap breaks the streak; the older chain does not extend it")
}

// streak: no rows at all = 0. No future-dated rows contribute to the streak.
func TestCountStatsExtendedStreakEmpty(t *testing.T) {
	s := newTestStore(t)
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	got, err := s.CountStatsExtended(context.Background(), now)
	require.NoError(t, err)
	require.Equal(t, 0, got.Streak)
	require.Empty(t, got.TopIssues)
	require.Equal(t, int64(0), got.WordsThisWeek)
}

// streak: activity only on older days (NOT ending today) is NOT a streak.
// The user must have done something today for the chain to start.
func TestCountStatsExtendedStreakDoesNotCountHistoricalOnly(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	_, _, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	ts := now.AddDate(0, 0, -3).UnixMilli() // 3 days ago, not today
	_, err = s.db.Exec(`UPDATE corrections SET ts = ?`, ts)
	require.NoError(t, err)

	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, 0, got.Streak, "no activity today = no streak, even if historical activity exists")
}

// words_this_week: sum of the word count of corrections.suggestion for
// corrections logged in the last 7 days (from now-7d inclusive to now
// inclusive). Word count uses strings.Fields (whitespace-delimited
// tokens) on the raw text. The sum is mathematically exact for the
// rows in the 7d window — the "approximate" qualifier applies to the
// schema design (no dedicated word_count column) and is documented
// in the spec. The column that would make this O(1) is a per-row
// word_count INTEGER on corrections, set at LogCorrection time.
func TestCountStatsExtendedWordsThisWeek(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)

	seed := func(text string, daysAgo int) {
		_, _, err := s.LogCorrection(ctx, correction.Event{
			Source: correction.SourceVencord, Original: "x", Suggestion: text, Model: correction.ModelLLM,
			Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y", Model: correction.ModelLLM}},
		})
		require.NoError(t, err)
		ts := now.AddDate(0, 0, -daysAgo).UnixMilli()
		_, err = s.db.Exec(`UPDATE corrections SET ts = ? WHERE id = (SELECT MAX(id) FROM corrections)`, ts)
		require.NoError(t, err)
	}
	// 10 words in the window (today)
	seed("one two three four five six seven eight nine ten", 0)
	// 5 words in the window (3 days ago)
	seed("alpha beta gamma delta epsilon", 3)
	// 8 words OUTSIDE the 7d window (10 days ago) — must not contribute
	seed("a b c d e f g h", 10)
	// 7 words on the boundary (exactly 7 days ago) — included (7d window is inclusive)
	seed("w1 w2 w3 w4 w5 w6 w7", 7)

	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, int64(10+5+7), got.WordsThisWeek,
		"10 + 5 + 7 = 22 words inside the inclusive 7d window; the 8 words at day -10 are excluded")
}

// words_this_week on an empty store is exactly zero, not a missing field.
func TestCountStatsExtendedWordsThisWeekEmpty(t *testing.T) {
	s := newTestStore(t)
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	got, err := s.CountStatsExtended(context.Background(), now)
	require.NoError(t, err)
	require.Equal(t, int64(0), got.WordsThisWeek)
}

// The aggregation MUST be additive with the rest of /stats: an edit logged
// without a signal still counts toward top_issues (top_issues is "what the
// corrector flagged", not "what the user accepted") and toward streak (a
// correction was logged). A test that seeds edits and ignores half of them
// proves no implicit signal filter is being applied.
func TestCountStatsExtendedIncludesSignallessEdits(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	_, _, err := s.LogCorrection(ctx, correction.Event{
		Source: correction.SourceVencord, Original: "x", Suggestion: "y", Model: correction.ModelLLM,
		Edits: []correction.EditRecord{{
			SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y",
			Model: correction.ModelLLM, Category: correction.CategorySpelling,
		}},
	})
	require.NoError(t, err)
	// No LogSignal call — the edit stays unsignaled. Backdate the
	// correction to `now` so the streak walks against the synthetic date
	// (real-time LogCorrection stamps ts = time.Now(), which would
	// shift the day if the test runs on a non-2026-06-15 machine).
	_, err = s.db.Exec(`UPDATE corrections SET ts = ?`, now.UnixMilli())
	require.NoError(t, err)

	got, err := s.CountStatsExtended(ctx, now)
	require.NoError(t, err)
	require.Equal(t, []correction.CategoryCount{
		{Category: correction.CategorySpelling, Count: 1},
	}, got.TopIssues, "signalless edits MUST still count toward top_issues")
	require.Equal(t, 1, got.Streak, "an unsignaled correction today still counts as an active day")
}

func TestSignalRatesByModelCategory(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	_, editIDs, err := st.LogCorrection(ctx, correction.Event{
		Source: correction.SourceBrowser, Original: "teh cat go", Suggestion: "the cat goes", //nolint:misspell // intentional fixture
		Model: correction.ModelLLM, BaseModel: "test-model",
		Edits: []correction.EditRecord{
			{SpanStart: 0, SpanEnd: 3, Original: "teh", Replacement: "the", Model: correction.ModelHarper, Category: correction.CategorySpelling, Confidence: 0.95}, //nolint:misspell // intentional fixture
			{SpanStart: 8, SpanEnd: 10, Original: "go", Replacement: "goes", Model: correction.ModelLLM},
			{SpanStart: 4, SpanEnd: 7, Original: "cat", Replacement: "cats", Model: correction.ModelLLM},
		},
	})
	require.NoError(t, err)
	require.Len(t, editIDs, 3)
	require.NoError(t, st.LogSignal(ctx, editIDs[0], correction.SignalAccepted))
	require.NoError(t, st.LogSignal(ctx, editIDs[1], correction.SignalAccepted))
	require.NoError(t, st.LogSignal(ctx, editIDs[2], correction.SignalRejected))
	// An ignored edit must appear in NEITHER count — log one and ignore it.
	_, moreIDs, err := st.LogCorrection(ctx, correction.Event{
		Source: correction.SourceBrowser, Original: "x", Suggestion: "y",
		Model: correction.ModelLLM, BaseModel: "test-model",
		Edits: []correction.EditRecord{{SpanStart: 0, SpanEnd: 1, Original: "x", Replacement: "y", Model: correction.ModelLLM}},
	})
	require.NoError(t, err)
	require.NoError(t, st.LogSignal(ctx, moreIDs[0], correction.SignalIgnored))

	rates, err := st.SignalRates(ctx)
	require.NoError(t, err)
	byKey := map[string]correction.SignalRate{}
	for _, r := range rates {
		byKey[string(r.Model)+"|"+r.Category] = r
	}
	require.Equal(t, 1, byKey["harper|spelling"].Accepted)
	require.Equal(t, 0, byKey["harper|spelling"].Rejected)
	require.Equal(t, 1, byKey["llm|"].Accepted)
	require.Equal(t, 1, byKey["llm|"].Rejected)
}
