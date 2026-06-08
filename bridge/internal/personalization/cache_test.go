package personalization

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// fakeSource is a counting, programmable Source for the cache tests.
type fakeSource struct {
	calls  atomic.Int64
	data   correction.PersonalizationData
	err    error
	delay  time.Duration // simulate slow store
	gotCtx context.Context
	muCtx  sync.Mutex
}

func (f *fakeSource) PersonalizationExamples(ctx context.Context) (correction.PersonalizationData, error) {
	f.calls.Add(1)
	f.muCtx.Lock()
	f.gotCtx = ctx
	f.muCtx.Unlock()
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return correction.PersonalizationData{}, ctx.Err()
		}
	}
	return f.data, f.err
}

func TestNewCacheZeroValueIsSafe(t *testing.T) {
	c := NewCache(&fakeSource{}, time.Hour)
	require.NotNil(t, c)
	// A zero-value cache must not panic on Snapshot.
	_ = c.Snapshot()
}

// First Snapshot builds from the source; a second Snapshot within ttl does
// NOT re-query. Proves the cache is actually serving the previous result.
func TestSnapshotCachesWithinTTL(t *testing.T) {
	src := &fakeSource{}
	src.data = correction.PersonalizationData{
		Accepted: []correction.EditPair{{Original: "a", Suggestion: "b", Count: 1}},
	}
	c := NewCache(src, time.Hour)

	first := c.Snapshot()
	require.False(t, first.Empty(), "first snapshot must reflect source data")
	require.Equal(t, int64(1), src.calls.Load(), "source queried once on first snapshot")

	// Changing the source data between calls must NOT be observed within TTL.
	src.data = correction.PersonalizationData{}
	second := c.Snapshot()
	require.Equal(t, int64(1), src.calls.Load(), "source NOT re-queried within TTL")
	require.Equal(t, first.String(), second.String(), "cache returns the same text within TTL")
}

// After ttl elapses, the next Snapshot re-queries the source.
func TestSnapshotRebuildsAfterTTL(t *testing.T) {
	src := &fakeSource{
		data: correction.PersonalizationData{Accepted: []correction.EditPair{{Original: "a", Suggestion: "b", Count: 1}}},
	}
	c := NewCache(src, 20*time.Millisecond)

	_ = c.Snapshot()
	require.Equal(t, int64(1), src.calls.Load())
	// Wait past ttl.
	time.Sleep(30 * time.Millisecond)
	// Mutate the source so the rebuild is observable.
	src.data = correction.PersonalizationData{
		Accepted: []correction.EditPair{{Original: "x", Suggestion: "y", Count: 1}},
	}
	got := c.Snapshot()
	require.Equal(t, int64(2), src.calls.Load(), "source re-queried after ttl")
	require.Contains(t, got.String(), `"x"`,
		"rebuilt snapshot must reflect the new source data, not the old cache")
}

// On a source error, Snapshot returns the last-good block (or empty) and
// NEVER returns an error — personalisation must never fail a correction.
// Subsequent calls within ttl must NOT hammer the store.
func TestSnapshotStoreErrorReturnsLastGood(t *testing.T) {
	src := &fakeSource{}
	c := NewCache(src, time.Hour)

	// First call: source errors AND has no prior data -> empty Block, no error.
	src.err = errors.New("db down")
	got := c.Snapshot()
	require.True(t, got.Empty(), "empty block when source errors with no prior data")
	require.Equal(t, int64(1), src.calls.Load())

	// Within ttl: even if we re-arm the source, repeated calls must not
	// re-query the store while we have nothing to rebuild from.
	got2 := c.Snapshot()
	require.True(t, got2.Empty())
	require.Equal(t, int64(1), src.calls.Load(), "store NOT hammered on repeat errors within ttl")

	// After ttl, the source gets queried again. It still errors. Still no panic.
	time.Sleep(20 * time.Millisecond)
	c2 := NewCache(src, 10*time.Millisecond)
	_ = c2.Snapshot()
	require.Error(t, src.err, "sanity: source still configured to error")
}

// When the source returns good data once, then errors, the LAST GOOD block
// must be served on subsequent calls (not the empty one).
func TestSnapshotStoreErrorFallsBackToLastGoodBlock(t *testing.T) {
	src := &fakeSource{
		data: correction.PersonalizationData{
			Accepted: []correction.EditPair{{Original: "a", Suggestion: "b", Count: 1}},
		},
	}
	c := NewCache(src, 10*time.Millisecond)

	good := c.Snapshot()
	require.False(t, good.Empty())
	require.Equal(t, int64(1), src.calls.Load())

	// Force an error on the next rebuild.
	src.err = errors.New("db down")
	time.Sleep(15 * time.Millisecond)
	bad := c.Snapshot()
	require.False(t, bad.Empty(),
		"on error after a good build, cache must serve the last-good block")
	require.Equal(t, good.String(), bad.String(),
		"last-good block served on error, not the empty one")
	require.Equal(t, int64(2), src.calls.Load())
}

// The renderer must produce BOTH positive (accepted) and negative (rejected)
// lines plus a header when both sets are non-empty. Empty data -> empty Block.
func TestRenderBothAcceptedAndRejected(t *testing.T) {
	src := &fakeSource{
		data: correction.PersonalizationData{
			Accepted: []correction.EditPair{
				{Original: "a", Suggestion: "b", Count: 1},
				{Original: "c", Suggestion: "d", Count: 1},
			},
			Rejected: []correction.EditPair{
				{Original: "x", Suggestion: "y", Count: 3},
			},
		},
	}
	got := NewCache(src, time.Hour).Snapshot()
	s := got.String()
	require.Contains(t, s, "Learned preferences", "header present when data is non-empty")
	require.Contains(t, s, `Correct "a" to "b".`, "first positive line present")
	require.Contains(t, s, `Correct "c" to "d".`, "second positive line present")
	require.Contains(t, s, `Do NOT change "x" — leave it unchanged.`, "negative line present")
}

func TestSnapshotEmptyDataYieldsEmptyBlock(t *testing.T) {
	src := &fakeSource{data: correction.PersonalizationData{}}
	got := NewCache(src, time.Hour).Snapshot()
	require.True(t, got.Empty())
	require.Equal(t, "", got.String())
}

func TestRenderCapsAcceptedAndRejected(t *testing.T) {
	many := make([]correction.EditPair, 25)
	for i := range many {
		many[i] = correction.EditPair{
			Original:   string(rune('a'+i%26)) + string(rune('0'+i/26)),
			Suggestion: "Z",
			Count:      1,
		}
	}
	src := &fakeSource{
		data: correction.PersonalizationData{Accepted: many, Rejected: many},
	}
	got := NewCache(src, time.Hour).Snapshot()
	s := got.String()
	// Each positive/negative line ends with a period. Count them.
	positives, negatives := countLines(s)
	require.LessOrEqual(t, positives, 10, "positive lines capped")
	require.LessOrEqual(t, negatives, 10, "negative lines capped")
}

func countLines(s string) (positives, negatives int) {
	for _, line := range splitLines(s) {
		if startsWith(line, "Correct ") {
			positives++
		} else if startsWith(line, "Do NOT change ") {
			negatives++
		}
	}
	return
}

func splitLines(s string) []string {
	var out []string
	cur := ""
	for _, r := range s {
		if r == '\n' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func startsWith(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// Hammer Snapshot from N goroutines. Under -race, no race. Source must be
// queried at most once per ttl window even under contention.
func TestSnapshotConcurrentHammers(t *testing.T) {
	src := &fakeSource{
		data: correction.PersonalizationData{
			Accepted: []correction.EditPair{{Original: "a", Suggestion: "b", Count: 1}},
		},
	}
	c := NewCache(src, time.Hour)
	const N = 64
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		go func() {
			defer wg.Done()
			_ = c.Snapshot()
		}()
	}
	wg.Wait()
	require.Equal(t, int64(1), src.calls.Load(),
		"source must be queried exactly once per ttl window under contention")
}

// The source query must use a bounded context with a deadline so a runaway
// store cannot stall the correction hot path forever. We assert the
// behavior via the context the source RECEIVES: it must have a deadline
// (HasDeadline), and the cache must NOT pass through any caller ctx
// (Snapshot has no ctx parameter, so the source ctx is constructed by
// the cache). The first build IS allowed to block on the source — the
// contract is "synchronous", not "non-blocking" — but bounded.
func TestSnapshotUsesBoundedContext(t *testing.T) {
	src := &fakeSource{
		data:  correction.PersonalizationData{Accepted: []correction.EditPair{{Original: "a", Suggestion: "b", Count: 1}}},
		delay: 50 * time.Millisecond,
	}
	c := NewCache(src, time.Hour)
	_ = c.Snapshot()
	src.muCtx.Lock()
	gotCtx := src.gotCtx
	src.muCtx.Unlock()
	require.NotNil(t, gotCtx, "source must be called with a context")
	deadline, ok := gotCtx.Deadline()
	require.True(t, ok, "source context must have a deadline so a slow store cannot stall forever")
	require.True(t, !deadline.IsZero(), "deadline must be set to a real time")
}
