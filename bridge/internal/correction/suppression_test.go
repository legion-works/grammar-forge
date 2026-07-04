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
	// succeedFirst: when true, the FIRST call returns (data, nil) and
	// every subsequent call returns (data, err). Lets the populated-
	// last-good test model "first refresh succeeds, later refreshes
	// fail" — the cache is built, then a later refresh errors out and
	// must preserve the populated map. Default false preserves the
	// existing "always honour err" semantics.
	succeedFirst bool
}

func (f *fakeSuppressionStore) PersonalizationExamples(context.Context) (PersonalizationData, error) {
	n := f.calls.Add(1)
	if f.blockFor > 0 {
		time.Sleep(f.blockFor)
	}
	if f.succeedFirst && n == 1 {
		return f.data, nil
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
// count) rather than the internal flag. The follow-up require.Never is
// the load-bearing part of this test: it proves the count STAYS at 1
// over a generous window, catching a late-arriving second refresh that
// would only show up after the first refresh completes and clears
// `refreshing` — a race the simple equality check above can miss on a
// contended machine.
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
	require.Never(t, func() bool { return st.calls.Load() > 1 },
		300*time.Millisecond, 25*time.Millisecond,
		"single-flight invariant: late-arriving refreshes must not inflate calls above 1")
}

// A populated last-good snapshot must survive a LATER refresh error:
// the cache holds the pairs the first successful refresh loaded, and a
// failed refresh must not wipe them — the user keeps seeing their
// vocabulary preferences even when SQLite is briefly unavailable after
// the initial load. The store is configured to succeed exactly once
// (succeedFirst) so the test exercises the failure path against a
// populated cache, not a cold one. A tiny TTL (50ms) is used so the
// post-warm Suppressed call naturally hits expiry within the polling
// window; no manual sleep is needed because the require.Eventually
// poll cadence (~5ms) intersects the TTL within ~10 iterations.
func TestSuppressedStoreErrorKeepsPopulatedLastGood(t *testing.T) {
	st := &fakeSuppressionStore{
		fakeStore: &fakeStore{},
		data: PersonalizationData{
			Rejected: []EditPair{{Original: "setup", Suggestion: "set up", Count: 4}},
		},
		err:          errors.New("db locked"),
		succeedFirst: true,
	}
	rs := NewRejectSuppressor(st, 50*time.Millisecond)

	// Step 1: first refresh succeeds — pair is in the cache.
	require.Eventually(t, func() bool {
		return rs.Suppressed(context.Background(), "setup", "set up")
	}, time.Second, 5*time.Millisecond,
		"first refresh must populate the cache")
	require.Equal(t, int64(1), st.calls.Load(),
		"exactly one store call so far")

	// Step 2: keep calling Suppressed until the 50ms TTL expires and a
	// second (failing) refresh runs. The Eventually poll cadence
	// (~5ms) intersects the TTL within ~10 iterations, so this is
	// effectively a deterministic wait with no manual sleep.
	require.Eventually(t, func() bool {
		_ = rs.Suppressed(context.Background(), "setup", "set up")
		return st.calls.Load() >= 2
	}, 2*time.Second, 5*time.Millisecond,
		"post-expiry Suppressed must kick a second (failing) refresh")

	// Step 3: the populated last-good set must STILL suppress the pair
	// after the failing refresh. Eventually with a generous window
	// because subsequent Suppressed calls keep kicking background
	// refreshes (builtAt is reset on error so every call sees the
	// snapshot as expired); the assertion passes as long as no refresh
	// ever wipes the populated pairs map.
	require.Eventually(t, func() bool {
		return rs.Suppressed(context.Background(), "setup", "set up")
	}, 2*time.Second, 5*time.Millisecond,
		"populated last-good must survive a later refresh error")
}
