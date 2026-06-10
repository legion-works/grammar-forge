// Package personalization renders the prompt-cache few-shot block from the
// aggregated accept/reject history returned by Store.PersonalizationExamples.
// The cache is rebuilt lazily (no background goroutine) on a TTL: the
// PromptBuilder reads a synchronous snapshot, so a stale or empty block
// never fails a correction — Snapshot is best-effort.
package personalization

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
)

// sourceQueryTimeout bounds the per-rebuild store call so a slow DB cannot
// stall the correction hot path. 2s is well above a healthy SQLite query
// but well below a user-visible request.
const sourceQueryTimeout = 2 * time.Second

// Source is the slice of the store the cache needs.
type Source interface {
	PersonalizationExamples(ctx context.Context) (correction.PersonalizationData, error)
}

// Block is the rendered few-shot text injected into the chat system prompt.
// It is intentionally an opaque value type so the prompt package can append
// it to the system prompt without learning the rendering details.
type Block struct {
	text string
}

// String returns the rendered few-shot text. Empty when no examples exist.
func (b Block) String() string { return b.text }

// Empty reports whether the block contains no text. The prompt builder
// uses this to decide whether to inject.
func (b Block) Empty() bool { return b.text == "" }

// NewBlockForTest constructs a Block from raw text. It is exported ONLY for
// tests (the production renderer is renderBlock in this package). It lets
// the prompt package's test fakes build a Block without depending on a
// real Source.
func NewBlockForTest(text string) Block { return Block{text: text} }

// Cache holds a TTL-cached snapshot of the personalisation few-shot block.
// Snapshot is safe for concurrent use; the lock is held for the whole
// query+render so N concurrent callers in a cold window collapse to one
// store query (others see the freshly-built block under the lock).
type Cache struct {
	src Source
	ttl time.Duration

	mu      sync.Mutex
	snap    Block
	builtAt time.Time
	built   bool
}

// NewCache returns a Cache that reads from src and rebuilds when the
// snapshot is older than ttl. A non-positive ttl disables caching (every
// Snapshot re-queries); use a real positive value in production.
func NewCache(src Source, ttl time.Duration) *Cache {
	return &Cache{src: src, ttl: ttl}
}

// Snapshot returns the current few-shot Block, rebuilding from the source if
// older than ttl (or never built). Synchronous and best-effort: on a store
// error it returns the last good snapshot (or an empty Block) and NEVER
// returns an error — personalisation must never fail a correction.
func (c *Cache) Snapshot() Block {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.built && time.Since(c.builtAt) < c.ttl {
		return c.snap
	}

	// Bound the store call with a fresh context: Snapshot is called from
	// the hot path and must not inherit any caller cancellation, nor stall
	// forever on a slow DB.
	ctx, cancel := context.WithTimeout(context.Background(), sourceQueryTimeout)
	defer cancel()

	data, err := c.src.PersonalizationExamples(ctx)
	// Always advance builtAt: a persistent store error must NOT cause
	// Snapshot to hammer the store on every keystroke. The rebuilt
	// snapshot is whatever we serve this round — the previous good block
	// if we have one, else the empty block. The previous-good path is
	// important: a transient error during steady-state operation must
	// not visibly drop the user's learned preferences.
	c.builtAt = time.Now()
	c.built = true
	if err != nil {
		slog.Warn("personalization: store query failed; serving last-good or empty")
		return c.snap
	}
	c.snap = renderBlock(data)
	return c.snap
}

// renderBlock turns the aggregated data into the few-shot text. It is
// pure and total: no I/O, no panics on empty input. Empty data -> empty
// Block; the prompt builder uses Block.Empty to decide whether to inject.
//
// SECURITY: Original and Suggestion come from the user's signal log —
// they are user-controlled text, NOT a trusted template. We render each
// through strconv.Quote (which escapes quotes, backslashes, and
// non-printable bytes including \n into the literal two-character \n)
// so a single example occupies exactly one rendered line. Raw
// concatenation would let an embedded " break out of the example
// literal and an embedded \n smuggle a new prompt line into the system
// prompt — a prompt-injection vector (the "user's" text would appear as
// a system instruction to the LLM).
func renderBlock(data correction.PersonalizationData) Block {
	positive := capSlice(data.Accepted, 10)
	negative := capSlice(data.Rejected, 10)
	if len(positive) == 0 && len(negative) == 0 {
		return Block{}
	}
	var b []byte
	b = append(b, "\n\nLearned preferences:\n"...)
	for _, p := range positive {
		b = append(b, "Correct "...)
		b = strconv.AppendQuote(b, p.Original)
		b = append(b, " to "...)
		b = strconv.AppendQuote(b, p.Suggestion)
		b = append(b, ".\n"...)
	}
	for _, p := range negative {
		b = append(b, "Do NOT change "...)
		b = strconv.AppendQuote(b, p.Original)
		b = append(b, " \u2014 leave it unchanged.\n"...)
	}
	text := string(b)
	if len(text) > 2000 {
		// Truncate on the last COMPLETE example line within the cap: a
		// mid-rune cut yields invalid UTF-8 and a mid-line cut leaves a
		// dangling half-instruction in the system prompt.
		cut := strings.LastIndexByte(text[:2000], '\n')
		if cut < 0 {
			return Block{}
		}
		text = text[:cut+1]
	}
	return Block{text: text}
}

func capSlice(s []correction.EditPair, n int) []correction.EditPair {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
