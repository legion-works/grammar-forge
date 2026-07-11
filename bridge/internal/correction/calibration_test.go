package correction

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeRateStore embeds *fakeStore to satisfy the Store interface and
// overrides the one method the calibrator actually calls. `calls` is
// atomic because the single-flight test hits SignalRates from a
// goroutine. Mirrors fakeSuppressionStore in suppression_test.go.
type fakeRateStore struct {
	*fakeStore
	rates    []SignalRate
	err      error
	blockFor time.Duration
	calls    atomic.Int64
	// succeedFirst: when true, the FIRST call returns (rates, nil) and
	// every subsequent call returns (rates, err). Lets the populated-
	// last-good test model "first refresh succeeds, later refreshes
	// fail".
	succeedFirst bool
}

func (f *fakeRateStore) SignalRates(context.Context) ([]SignalRate, error) {
	n := f.calls.Add(1)
	if f.blockFor > 0 {
		time.Sleep(f.blockFor)
	}
	if f.succeedFirst && n == 1 {
		return f.rates, nil
	}
	return f.rates, f.err
}

// Cold first call falls back to raw (stale-while-revalidate: the snapshot
// is unbuilt so we cannot block); the calibrated value becomes observable
// only AFTER the background refresh completes.
func TestCalibratorColdCallFallsBackThenWarms(t *testing.T) {
	st := &fakeRateStore{
		fakeStore: &fakeStore{},
		rates:     []SignalRate{{Model: ModelHarper, Category: CategorySpelling, Accepted: 18, Rejected: 2}},
	}
	c := NewConfidenceCalibrator(st, time.Minute, 10, slog.Default())
	_, ok := c.Calibrated(ModelHarper, CategorySpelling, 0.95)
	require.False(t, ok, "cold call must fall back, not block on the store")
	require.Eventually(t, func() bool {
		got, ok := c.Calibrated(ModelHarper, CategorySpelling, 0.95)
		return ok && math.Abs(got-(18.0+1)/(18.0+2+2)) < 1e-9 // 19/22 ~= 0.8636
	}, time.Second, 5*time.Millisecond, "background refresh must surface the calibrated value")
}

// A bucket with fewer than minSamples signaled edits never calibrates: the
// caller must keep falling back to raw regardless of how many times it
// asks, even once the snapshot has warmed.
func TestCalibratorMinSamplesFallsBack(t *testing.T) {
	st := &fakeRateStore{
		fakeStore: &fakeStore{},
		rates:     []SignalRate{{Model: ModelLLM, Category: "", Accepted: 3, Rejected: 1}},
	}
	c := NewConfidenceCalibrator(st, time.Minute, 10, slog.Default())
	c.Calibrated(ModelLLM, "", 0)  // kick refresh
	require.Never(t, func() bool { // 4 samples < 10 -> never ok
		_, ok := c.Calibrated(ModelLLM, "", 0)
		return ok
	}, 200*time.Millisecond, 10*time.Millisecond)
}

// N parallel cold calls against a blocking store collapse to exactly one
// background refresh. The follow-up require.Never is the load-bearing
// part: it proves the count STAYS at 1 over a generous window, catching a
// late-arriving second refresh that would only show up after the first
// refresh completes and clears `refreshing`.
func TestCalibratorSingleFlightRefresh(t *testing.T) {
	st := &fakeRateStore{
		fakeStore: &fakeStore{},
		blockFor:  200 * time.Millisecond,
	}
	c := NewConfidenceCalibrator(st, time.Hour, 10, slog.Default())
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Calibrated(ModelHarper, CategorySpelling, 0.5)
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

// A populated last-good snapshot must survive a LATER refresh error: the
// cache holds the calibrated values the first successful refresh loaded,
// and a failed refresh must not wipe them. A tiny TTL (50ms) is used so
// the post-warm Calibrated call naturally hits expiry within the polling
// window.
func TestCalibratorStoreErrorKeepsLastGood(t *testing.T) {
	st := &fakeRateStore{
		fakeStore:    &fakeStore{},
		rates:        []SignalRate{{Model: ModelHarper, Category: CategorySpelling, Accepted: 18, Rejected: 2}},
		err:          errors.New("db locked"),
		succeedFirst: true,
	}
	c := NewConfidenceCalibrator(st, 50*time.Millisecond, 10, slog.Default())

	want := (18.0 + 1) / (18.0 + 2 + 2)

	// Step 1: first refresh succeeds - value is in the cache.
	require.Eventually(t, func() bool {
		got, ok := c.Calibrated(ModelHarper, CategorySpelling, 0.95)
		return ok && math.Abs(got-want) < 1e-9
	}, time.Second, 5*time.Millisecond, "first refresh must populate the cache")
	require.Equal(t, int64(1), st.calls.Load(), "exactly one store call so far")

	// Step 2: keep calling Calibrated until the 50ms TTL expires and a
	// second (failing) refresh runs.
	require.Eventually(t, func() bool {
		c.Calibrated(ModelHarper, CategorySpelling, 0.95)
		return st.calls.Load() >= 2
	}, 2*time.Second, 5*time.Millisecond, "post-expiry Calibrated must kick a second (failing) refresh")

	// Step 3: the populated last-good value must STILL be served after
	// the failing refresh.
	require.Eventually(t, func() bool {
		got, ok := c.Calibrated(ModelHarper, CategorySpelling, 0.95)
		return ok && math.Abs(got-want) < 1e-9
	}, 2*time.Second, 5*time.Millisecond, "populated last-good must survive a later refresh error")
}
