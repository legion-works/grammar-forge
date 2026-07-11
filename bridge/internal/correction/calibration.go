package correction

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// confidenceCalibratorRefreshTimeout bounds the detached background query so
// a wedged SQLite handle cannot leak goroutines. Mirrors
// rejectSuppressorRefreshTimeout in suppression.go.
const confidenceCalibratorRefreshTimeout = 5 * time.Second

// ConfidenceCalibrator replaces a model's raw confidence with the observed
// acceptance rate for that (model, category) bucket, so /correct confidence
// reflects reality instead of a fixed per-model constant. Backed by
// Store.SignalRates. TTL-cached with STALE-WHILE-REVALIDATE, mirroring
// RejectSuppressor exactly: an expired snapshot is served immediately while
// ONE background goroutine refreshes it — the request path never blocks on
// SQLite. Cold start (no snapshot yet) reports ok=false so the caller keeps
// the raw score, and kicks the same background refresh.
type ConfidenceCalibrator struct {
	store      Store
	ttl        time.Duration
	minSamples int
	log        *slog.Logger

	mu         sync.Mutex
	values     map[string]float64 // key: string(Model)+"\x00"+Category -> Laplace-smoothed precision
	samples    map[string]int     // key: same as values -> Accepted+Rejected
	builtAt    time.Time
	built      bool
	refreshing bool // single-flight: at most one background refresh goroutine
}

// NewConfidenceCalibrator returns a calibrator that reads signal rates from
// store and re-reads when the snapshot is older than ttl. A bucket needs at
// least minSamples signaled edits (Accepted+Rejected) before it is trusted;
// thinner buckets report ok=false so the caller keeps the raw confidence.
// ttl <= 0 means every Calibrated call kicks a refresh; use a real positive
// value in production.
func NewConfidenceCalibrator(store Store, ttl time.Duration, minSamples int, log *slog.Logger) *ConfidenceCalibrator {
	return &ConfidenceCalibrator{store: store, ttl: ttl, minSamples: minSamples, log: log}
}

// calibrationKey builds the snapshot map key for a (model, category) bucket.
// \x00 is used as the separator (mirroring EditPair-less map keys elsewhere
// in this package) since neither Model values nor category strings can
// contain a NUL byte.
func calibrationKey(model Model, category string) string {
	return string(model) + "\x00" + category
}

// Calibrated returns the Laplace-smoothed empirical acceptance rate for the
// (model, category) bucket in place of raw, plus whether that value is
// trustworthy enough to use. ok is false — meaning the caller should keep
// raw — when the snapshot hasn't been built yet (cold start), the bucket is
// absent, or the bucket has fewer than minSamples signaled edits.
//
// Never blocks on the store: on expiry or cold start it returns the current
// snapshot (stale or empty) and spawns at most one background refresh, so N
// concurrent calls in a cold window collapse to a single store query.
func (c *ConfidenceCalibrator) Calibrated(model Model, category string, raw float64) (float64, bool) {
	_ = raw // raw is not consulted here; the caller substitutes it when ok is false.
	key := calibrationKey(model, category)

	c.mu.Lock()
	if c.built && time.Since(c.builtAt) < c.ttl {
		v, samples := c.lookupLocked(key)
		c.mu.Unlock()
		if samples < c.minSamples {
			return 0, false
		}
		return v, true
	}
	if !c.refreshing {
		c.refreshing = true
		go c.refresh()
	}
	v, samples := c.lookupLocked(key)
	built := c.built
	c.mu.Unlock()
	if !built || samples < c.minSamples {
		return 0, false
	}
	return v, true
}

// lookupLocked reads the current snapshot for key. Caller must hold c.mu.
func (c *ConfidenceCalibrator) lookupLocked(key string) (float64, int) {
	return c.values[key], c.samples[key]
}

// refresh fetches a new snapshot in the background. Detached from any
// caller context (so a canceled request doesn't kill the refresh) and
// capped at 5s. On error we keep the prior snapshot and reset builtAt so
// the next call retries — a persistent store failure must not silently turn
// calibration off forever, but also must not hot-loop the store on every
// keystroke the way a synchronous cache would.
func (c *ConfidenceCalibrator) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), confidenceCalibratorRefreshTimeout)
	defer cancel()
	rates, err := c.store.SignalRates(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.refreshing = false
	if err != nil {
		c.log.Warn("confidence calibrator refresh failed; keeping last-good", "err", err)
		// Reset builtAt so the next Calibrated call treats the snapshot as
		// expired and triggers another refresh attempt.
		c.builtAt = time.Time{}
		return
	}
	values := make(map[string]float64, len(rates))
	samples := make(map[string]int, len(rates))
	for _, r := range rates {
		key := calibrationKey(r.Model, r.Category)
		// Laplace (add-one) smoothing: a bucket with 0 signals never divides
		// by zero, and a small bucket doesn't snap to a hard 0.0 or 1.0.
		values[key] = float64(r.Accepted+1) / float64(r.Accepted+r.Rejected+2)
		samples[key] = r.Accepted + r.Rejected
	}
	c.values = values
	c.samples = samples
	c.builtAt = time.Now()
	c.built = true
}
