package correction

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// rejectSuppressorRefreshTimeout bounds the detached background query so a
// wedged SQLite handle cannot leak goroutines. Well above a healthy SQLite
// read but well below anything a human would notice.
const rejectSuppressorRefreshTimeout = 5 * time.Second

// RejectSuppressor drops suggestions the user has repeatedly rejected.
// Backed by Store.PersonalizationExamples (rejected pairs, Count>=3 —
// the store applies the floor). TTL-cached with STALE-WHILE-REVALIDATE:
// an expired snapshot is served immediately while ONE background
// goroutine refreshes it — the request path never blocks on SQLite
// (not even on expiry; the <100ms fast-path budget survives a
// cache-expiry keystroke). Cold start (no snapshot yet) serves the
// empty set and kicks the same background refresh.
type RejectSuppressor struct {
	store Store
	ttl   time.Duration

	mu         sync.Mutex
	pairs      map[EditPair]struct{} // key uses Original+Suggestion only (Count zeroed)
	builtAt    time.Time
	built      bool
	refreshing bool // single-flight: at most one background refresh goroutine
}

// NewRejectSuppressor returns a Suppressor that reads rejection pairs from
// store and re-reads when the snapshot is older than ttl. ttl <= 0 means
// every Suppressed call kicks a refresh; use a real positive value in
// production.
func NewRejectSuppressor(store Store, ttl time.Duration) *RejectSuppressor {
	return &RejectSuppressor{store: store, ttl: ttl}
}

// Suppressed reports whether the (word-level original, word-level suggestion)
// pair is on the user's rejected list. Best-effort: a store error keeps the
// last-good set (or empty on cold start) and never fails the request.
//
// Never blocks on the store: on expiry or cold start it returns the current
// snapshot (stale or empty) and spawns at most one background refresh, so N
// concurrent calls in a cold window collapse to a single store query.
func (r *RejectSuppressor) Suppressed(_ context.Context, original, suggestion string) bool {
	// Count zeroed so map equality treats Count>=3 and Count>=7 as the same key.
	key := EditPair{Original: original, Suggestion: suggestion}

	r.mu.Lock()
	if r.built && time.Since(r.builtAt) < r.ttl {
		_, ok := r.pairs[key]
		r.mu.Unlock()
		return ok
	}
	if !r.refreshing {
		r.refreshing = true
		go r.refresh()
	}
	_, ok := r.pairs[key]
	r.mu.Unlock()
	return ok
}

// refresh fetches a new snapshot in the background. Detached from any caller
// context (so a canceled request doesn't kill the refresh) and capped at
// 5s. On error we keep the prior pairs and reset builtAt so the next call
// retries — a persistent store failure must not silently turn suppression
// off forever, but also must not hot-loop the store on every keystroke the
// way a synchronous cache would.
func (r *RejectSuppressor) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), rejectSuppressorRefreshTimeout)
	defer cancel()
	data, err := r.store.PersonalizationExamples(ctx)

	r.mu.Lock()
	defer r.mu.Unlock()
	r.refreshing = false
	if err != nil {
		slog.Warn("reject suppressor refresh failed; keeping last-good", "err", err)
		// Reset builtAt so the next Suppressed call treats the snapshot as
		// expired and triggers another refresh attempt.
		r.builtAt = time.Time{}
		return
	}
	pairs := make(map[EditPair]struct{}, len(data.Rejected))
	for _, p := range data.Rejected {
		p.Count = 0
		pairs[p] = struct{}{}
	}
	r.pairs = pairs
	r.builtAt = time.Now()
	r.built = true
}
