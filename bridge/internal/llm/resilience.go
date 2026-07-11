// Package llm — resilience.go adds bounded retry + a consecutive-failure
// circuit breaker shared by Client (client.go) and AnthropicClient
// (anthropic.go). Both backends previously made a single HTTP attempt per
// Complete call: a transient network blip or a backend hiccup (a 500, a
// dropped connection) went straight to the correction service's best-effort
// fallback (the fast-path result, or an empty grammar result on the
// LLM-only path) — safe, but throwing away an easily-recovered request. And
// with no breaker, a genuinely DEAD backend made every request pay the
// full 30s http.Client timeout before falling back, one request at a time,
// which is the worst possible failure mode under load (stacked timeouts
// instead of a fast, cheap failure).
package llm

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"time"
)

// RetryConfig bounds the transient-failure retry behaviour. See
// config.go's GF_LLM_RETRY_* for the env-var wiring; DefaultRetryConfig is
// what New/NewAnthropic apply when the caller does not override it.
type RetryConfig struct {
	Enabled bool
	// MaxRetries is the number of EXTRA attempts beyond the first (1 means
	// "try, and if it fails transiently, try exactly once more").
	MaxRetries int
	// BaseDelay/MaxDelay bound the jittered backoff before a retry: the
	// actual sleep is a uniform random duration in [BaseDelay, MaxDelay].
	// Kept short (hundreds of ms) relative to the 30s per-attempt HTTP
	// timeout so a retry never meaningfully blows the existing latency
	// budget — worst case is one wasted 30s attempt plus a sub-second
	// backoff plus one more attempt, not an unbounded retry storm.
	BaseDelay time.Duration
	MaxDelay  time.Duration
}

// DefaultRetryConfig is the conservative default: retry on, exactly one
// retry, 200-500ms jittered backoff.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{Enabled: true, MaxRetries: 1, BaseDelay: 200 * time.Millisecond, MaxDelay: 500 * time.Millisecond}
}

// BreakerConfig configures the consecutive-failure circuit breaker. See
// config.go's GF_LLM_BREAKER_* for the env-var wiring; DefaultBreakerConfig
// is what New/NewAnthropic apply when the caller does not override it.
type BreakerConfig struct {
	Enabled bool
	// FailureThreshold consecutive failures (post-retry) opens the circuit.
	FailureThreshold int
	// Cooldown is how long the breaker stays open before allowing exactly
	// one half-open probe request.
	Cooldown time.Duration
}

// DefaultBreakerConfig is the conservative default: breaker on, 5
// consecutive failures opens it, 30s cooldown before a probe.
func DefaultBreakerConfig() BreakerConfig {
	return BreakerConfig{Enabled: true, FailureThreshold: 5, Cooldown: 30 * time.Second}
}

// breakerState is the circuit breaker's three states (standard circuit-
// breaker pattern: closed -> open on repeated failure -> half-open probe
// -> closed on probe success / open again on probe failure).
type breakerState int

const (
	breakerClosed breakerState = iota
	breakerOpen
	breakerHalfOpen
)

// circuitBreaker is a simple consecutive-failure breaker shared by every
// Complete call on one Client/AnthropicClient instance (one breaker per
// configured backend — the rephrase/tone override backends each get their
// own via their own New/NewAnthropic call, which is correct: a dead
// override backend must not trip the default backend's breaker or vice
// versa). Safe for concurrent use.
type circuitBreaker struct {
	cfg BreakerConfig
	mu  sync.Mutex

	state    breakerState
	failures int
	openedAt time.Time
	// probing is true while a half-open probe request is in flight, so a
	// second concurrent caller does not ALSO get allowed through during the
	// same probe window (only one probe at a time).
	probing bool
}

func newCircuitBreaker(cfg BreakerConfig) *circuitBreaker {
	return &circuitBreaker{cfg: cfg}
}

// Allow reports whether a request may proceed. Disabled breakers always
// allow. An open breaker allows exactly one half-open probe once Cooldown
// has elapsed since it opened; the probe's outcome (RecordSuccess /
// RecordFailure) decides whether the circuit closes or re-opens.
func (b *circuitBreaker) Allow() bool {
	if b == nil || !b.cfg.Enabled {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case breakerClosed:
		return true
	case breakerOpen:
		if time.Since(b.openedAt) < b.cfg.Cooldown {
			return false
		}
		if b.probing {
			return false // a probe is already in flight; don't pile on
		}
		b.state = breakerHalfOpen
		b.probing = true
		return true
	case breakerHalfOpen:
		return false // probe already in flight
	}
	return true
}

// RecordSuccess closes the breaker and resets the failure count.
func (b *circuitBreaker) RecordSuccess() {
	if b == nil || !b.cfg.Enabled {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.state = breakerClosed
	b.failures = 0
	b.probing = false
}

// RecordFailure records a failed call. In the closed state it increments
// the consecutive-failure count and opens the circuit once the threshold is
// hit; a failed half-open probe re-opens immediately (fresh cooldown).
func (b *circuitBreaker) RecordFailure() {
	if b == nil || !b.cfg.Enabled {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == breakerHalfOpen {
		b.state = breakerOpen
		b.openedAt = time.Now()
		b.probing = false
		return
	}
	b.failures++
	if b.failures >= b.cfg.FailureThreshold {
		b.state = breakerOpen
		b.openedAt = time.Now()
		b.probing = false
	}
}

// State reports the breaker's current state as a metrics-friendly string
// ("closed" | "open" | "half_open"), used by the /stats cache_metrics block
// (see correction.CacheMetrics / correction.breakerStater). A nil breaker
// (should not happen via New/NewAnthropic, but defensive) reports "closed".
func (b *circuitBreaker) State() string {
	if b == nil {
		return "closed"
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case breakerOpen:
		return "open"
	case breakerHalfOpen:
		return "half_open"
	default:
		return "closed"
	}
}

// isTransientStatus reports whether an HTTP status code is worth retrying:
// 429 (rate limited) and 5xx (backend fault). 4xx (other than 429) is a
// permanent client-side problem — bad request, auth, not found — retrying
// would just reproduce the same failure. A successful-but-truncated
// response (finish_reason=length / stop_reason=max_tokens) is handled
// entirely OUTSIDE this retry layer (see client.go/anthropic.go: the
// truncation check runs after a 200 OK, once, never retried) because
// retrying a truncation would just regenerate the same-shaped truncated
// output at the model's current sampling settings.
func isTransientStatus(code int) bool {
	if code == http.StatusTooManyRequests {
		return true
	}
	return code >= 500 && code < 600
}

// jitterSleep sleeps a uniform-random duration in [base, maxDelay] (or
// exactly base if maxDelay <= base), honoring context cancellation. Returns
// ctx.Err() if the context is done before or during the sleep.
func jitterSleep(ctx context.Context, base, maxDelay time.Duration) error {
	d := base
	if maxDelay > base {
		d = base + time.Duration(rand.Int63n(int64(maxDelay-base+1))) //nolint:gosec // jittered backoff, not security-sensitive
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

// executeWithResilience runs one HTTP round-trip via hc, applying the
// circuit breaker and the retry policy around it. newReq builds a FRESH
// *http.Request per attempt (an http.Request's Body reader is single-use,
// so callers must supply a factory rather than a pre-built request when
// retries are possible). label distinguishes the two callers' error text
// ("llm" for Client, "anthropic" for AnthropicClient) without duplicating
// the wrapping logic.
//
// On success (status 200) it returns the *http.Response with the body NOT
// yet read — the caller decodes JSON and closes it, exactly as before this
// change. On a non-2xx or network-level failure it returns nil and an
// error; the breaker has already recorded the outcome by the time this
// function returns.
func executeWithResilience(
	ctx context.Context,
	hc *http.Client,
	breaker *circuitBreaker,
	retry RetryConfig,
	label string,
	newReq func() (*http.Request, error),
) (*http.Response, error) {
	if !breaker.Allow() {
		return nil, breakerOpenError{label: label}
	}

	attempts := 1
	if retry.Enabled && retry.MaxRetries > 0 {
		attempts += retry.MaxRetries
	}

	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			if err := jitterSleep(ctx, retry.BaseDelay, retry.MaxDelay); err != nil {
				breaker.RecordFailure()
				return nil, err
			}
		}
		req, err := newReq()
		if err != nil {
			// A request-build failure (bad URL, marshal error upstream) is
			// never transient and never the backend's fault — do not count
			// it against the breaker, and do not retry it.
			return nil, err
		}
		resp, err := hc.Do(req)
		if err != nil {
			lastErr = &requestError{label: label, err: err}
			if attempt < attempts-1 {
				continue // network-level errors are always transient
			}
			break
		}
		if resp.StatusCode == http.StatusOK {
			breaker.RecordSuccess()
			return resp, nil
		}
		status := resp.StatusCode
		_ = resp.Body.Close()
		lastErr = &statusError{label: label, status: status}
		if isTransientStatus(status) && attempt < attempts-1 {
			continue
		}
		break
	}
	breaker.RecordFailure()
	return nil, lastErr
}

// breakerOpenError is returned by executeWithResilience when the breaker is
// open. A distinct type (rather than a bare fmt.Errorf) so callers/tests
// can identify a fast-fail from an actual backend response if ever needed.
type breakerOpenError struct{ label string }

func (e breakerOpenError) Error() string {
	return e.label + ": circuit breaker open (backend failing repeatedly); fast-failing instead of stacking timeouts"
}

type requestError struct {
	label string
	err   error
}

func (e *requestError) Error() string { return e.label + " request: " + e.err.Error() }
func (e *requestError) Unwrap() error { return e.err }

type statusError struct {
	label  string
	status int
}

// Error mirrors the original pre-resilience wording exactly ("llm backend
// status %d" / "anthropic backend status %d") so any caller/log/test that
// matched on that substring keeps working unchanged.
func (e *statusError) Error() string {
	return fmt.Sprintf("%s backend status %d", e.label, e.status)
}
