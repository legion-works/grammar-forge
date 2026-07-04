package correction

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeSuppressionStore embeds *fakeStore to satisfy the Store interface
// (LogCorrection, LogSignal, CountCorrections, etc.) and overrides the one
// method the suppressor actually calls. `calls` is atomic because the
// single-flight test hits PersonalizationExamples from a goroutine.
type fakeSuppressionStore struct {
	*fakeStore
	data     PersonalizationData
	err      error
	blockFor time.Duration
	calls    atomic.Int64
}

func (f *fakeSuppressionStore) PersonalizationExamples(context.Context) (PersonalizationData, error) {
	f.calls.Add(1)
	if f.blockFor > 0 {
		time.Sleep(f.blockFor)
	}
	return f.data, f.err
}

// Cold first call serves empty (stale-while-revalidate: the snapshot is
// unbuilt so we cannot block); suppression becomes observable only AFTER
// the background refresh completes. The 5ms poll cadence trades CPU for
// test latency — the refresh itself takes far longer than that on every
// supported machine, so 5ms is just the loop's check interval.
func TestSuppressedMatchesRejectedPairAfterRefresh(t *testing.T) {
	st := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		data: PersonalizationData{
			Rejected: []EditPair{{Original: "setup", Suggestion: "set up", Count: 4}},
		},
	}
	rs := NewRejectSuppressor(st, time.Minute)
	require.False(t, rs.Suppressed(context.Background(), "setup", "set up"),
		"cold call must serve empty, not block on the store")
	require.Eventually(t, func() bool {
		return rs.Suppressed(context.Background(), "setup", "set up")
	}, time.Second, 5*time.Millisecond,
		"background refresh must surface the rejected pair")
	// Different Suggestion or different Original — same store, must NOT match.
	require.False(t, rs.Suppressed(context.Background(), "setup", "setups"))
	require.False(t, rs.Suppressed(context.Background(), "cleanup", "clean up"))
}

// Store blocks for 1s; Suppressed must return (false) in <=10ms. This is
// the load-bearing guarantee: the request path NEVER waits on the store,
// even on a cold cache.
func TestSuppressedNeverBlocksOnSlowStore(t *testing.T) {
	st := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		blockFor:  time.Second,
	}
	rs := NewRejectSuppressor(st, time.Minute)
	start := time.Now()
	require.False(t, rs.Suppressed(context.Background(), "setup", "set up"))
	require.Less(t, time.Since(start), 10*time.Millisecond,
		"Suppressed must not block on the store")
}

// A persistent store error must not panic or silently flip state: the
// cold call returns false (empty snapshot), the failed refresh keeps the
// empty last-good set, and the next call still returns false. We
// require.Eventually on calls>=1 to avoid racing the goroutine spawn.
func TestSuppressedStoreErrorKeepsLastGood(t *testing.T) {
	st := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		err:       errors.New("db locked"),
	}
	rs := NewRejectSuppressor(st, time.Minute)
	require.False(t, rs.Suppressed(context.Background(), "setup", "set up"))
	require.Eventually(t, func() bool { return st.calls.Load() >= 1 },
		time.Second, 5*time.Millisecond)
	require.False(t, rs.Suppressed(context.Background(), "setup", "set up"),
		"subsequent calls still serve the (empty) last-good set after a refresh error")
}

// N parallel cold calls against a blocking store collapse to exactly one
// background refresh. The `refreshing` flag under the mutex is the
// single-flight gate; the assertion checks the OBSERVED side (store call
// count) rather than the internal flag.
func TestSuppressedSingleFlightRefresh(t *testing.T) {
	st := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		blockFor:  200 * time.Millisecond,
	}
	rs := NewRejectSuppressor(st, time.Hour)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = rs.Suppressed(context.Background(), "setup", "set up")
		}()
	}
	wg.Wait()
	require.Eventually(t, func() bool { return st.calls.Load() == 1 },
		time.Second, 5*time.Millisecond,
		"only one of N parallel cold calls must kick a refresh")
}
