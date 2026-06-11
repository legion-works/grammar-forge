// Package store persists correction events and signals in SQLite via the pure-Go
// modernc.org/sqlite driver (no CGo). It implements correction.Store.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

const schema = `
CREATE TABLE IF NOT EXISTS corrections (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    source      TEXT NOT NULL,
    original    TEXT NOT NULL,
    suggestion  TEXT NOT NULL,
    model       TEXT NOT NULL,
    rule_id     TEXT,
    context     TEXT,
    base_model  TEXT,
    adapter     TEXT
);
CREATE INDEX IF NOT EXISTS idx_ts     ON corrections(ts);
CREATE TABLE IF NOT EXISTS edits (
    id            INTEGER PRIMARY KEY,
    correction_id INTEGER NOT NULL,
    span_start    INTEGER NOT NULL,
    span_end      INTEGER NOT NULL,
    original      TEXT NOT NULL,
    replacement   TEXT NOT NULL,
    model         TEXT NOT NULL,
    category      TEXT,
    rule_id       TEXT,
    confidence    REAL,
    signal        TEXT,
    signal_ts     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_edits_correction ON edits(correction_id);
CREATE INDEX IF NOT EXISTS idx_edits_signal ON edits(signal);
`

// SQLite is the correction.Store implementation.
type SQLite struct {
	db *sql.DB
}

// Open opens (or creates) the database at path and ensures the schema exists.
func Open(path string) (*SQLite, error) {
	// WAL + busy_timeout: concurrent /correct logging and /signal updates on
	// the default rollback journal produce "database is locked" under real
	// typing load. WAL allows a reader/writer mix; busy_timeout makes a
	// briefly-blocked writer wait instead of erroring.
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &SQLite{db: db}, nil
}

// LogCorrection inserts the event row plus one edits row per Event.Edits
// entry, atomically. Returns the correction id and the edit ids (parallel to
// ev.Edits) — Suggestion.ID is the EDIT id, the unit /signal attributes to.
func (s *SQLite) LogCorrection(ctx context.Context, ev correction.Event) (int64, []int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	res, err := tx.ExecContext(
		ctx,
		`INSERT INTO corrections (ts, source, original, suggestion, model, rule_id, context, base_model, adapter)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), string(ev.Source), ev.Original, ev.Suggestion,
		string(ev.Model), ev.RuleID, ev.Context, ev.BaseModel, ev.Adapter,
	)
	if err != nil {
		return 0, nil, fmt.Errorf("insert correction: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, nil, fmt.Errorf("correction id: %w", err)
	}
	editIDs := make([]int64, 0, len(ev.Edits))
	for _, e := range ev.Edits {
		r, err := tx.ExecContext(
			ctx,
			`INSERT INTO edits (correction_id, span_start, span_end, original, replacement, model, category, rule_id, confidence)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, e.SpanStart, e.SpanEnd, e.Original, e.Replacement,
			string(e.Model), e.Category, e.RuleID, e.Confidence,
		)
		if err != nil {
			return 0, nil, fmt.Errorf("insert edit: %w", err)
		}
		eid, err := r.LastInsertId()
		if err != nil {
			return 0, nil, fmt.Errorf("edit id: %w", err)
		}
		editIDs = append(editIDs, eid)
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, fmt.Errorf("commit: %w", err)
	}
	return id, editIDs, nil
}

// LogSignal records a user reaction on ONE edit. Unknown ids are a no-op.
func (s *SQLite) LogSignal(ctx context.Context, editID int64, signal correction.Signal) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE edits SET signal = ?, signal_ts = ? WHERE id = ?`,
		string(signal), time.Now().UnixMilli(), editID,
	)
	if err != nil {
		return fmt.Errorf("update signal: %w", err)
	}
	return nil
}

// CountCorrections returns the total row count.
func (s *SQLite) CountCorrections(ctx context.Context) (int64, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM corrections`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count corrections: %w", err)
	}
	return n, nil
}

// CountSignals aggregates the edits table by signal value for /stats.
func (s *SQLite) CountSignals(ctx context.Context) (correction.SignalCounts, error) {
	var c correction.SignalCounts
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*),
		       COUNT(CASE WHEN signal = 'accepted' THEN 1 END),
		       COUNT(CASE WHEN signal = 'rejected' THEN 1 END),
		       COUNT(CASE WHEN signal = 'ignored'  THEN 1 END)
		FROM edits`).Scan(&c.TotalEdits, &c.Accepted, &c.Rejected, &c.Ignored)
	if err != nil {
		return correction.SignalCounts{}, fmt.Errorf("count signals: %w", err)
	}
	return c, nil
}

// PersonalizationExamples aggregates the signal log into the few-shot pairs
// the prompt builder injects into the chat system prompt.
//
// The corrector logs edits as SPAN-LEVEL diff fragments (the diff between
// the LLM's rewrite and the original text often returns the changed suffix
// only — "has"→"have" stored as span over the trailing "s" with replacement
// "ve", "a"→"an" stored as "a"→"n", period inserts as ”→'.'). A few-shot
// block built from those raw fragments reads as `Correct "s" to "ve".` —
// junk that biases the LLM and caused the cold golden eval to regress from
// 125/125 → 110/125 (and the LLM to start deleting @mentions). At
// aggregation time we JOIN each edit to its parent correction, widen the
// span to the surrounding whitespace-delimited word boundaries, and
// reconstruct the WORD-LEVEL pair (e.g. "has"→"have") that the user
// actually accepted. Rows with invalid spans (span_end > len(parent) or
// start>end) and rows whose reconstructed original==suggestion are
// silently dropped.
//
// Both accepted and rejected pairs are ordered most-recent-first
// (MAX(signal_ts) DESC, then MAX(id) DESC for deterministic ties within
// the same millisecond) so the few-shot block reflects the user's LATEST
// preferences, not the loudest. Rejected pairs are filtered to Count>=3
// (a single reject is not a strong signal; three is a pattern). Both
// sets are capped at 20 rows. Rows with signal IS NULL (no user
// reaction) are ignored on both paths.
func (s *SQLite) PersonalizationExamples(ctx context.Context) (correction.PersonalizationData, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT e.id, c.original, e.span_start, e.span_end, e.replacement, e.signal, COALESCE(e.signal_ts, 0)
		FROM edits e
		JOIN corrections c ON c.id = e.correction_id
		WHERE e.signal IS NOT NULL
		  AND e.signal IN ('accepted', 'rejected', 'ignored')
		ORDER BY COALESCE(e.signal_ts, 0) DESC, e.id DESC`)
	if err != nil {
		return correction.PersonalizationData{}, fmt.Errorf("query pairs: %w", err)
	}
	defer func() { _ = rows.Close() }()

	// Two maps: one for accepted pairs, one for the negative pool
	// (rejected + ignored). The negative pool is filtered to Count>=3
	// at flatten time so the sort+cap is over the survivors only.
	acc := map[pairKey]*pairAgg{}
	rej := map[pairKey]*pairAgg{}
	for rows.Next() {
		var (
			id, signalTS        int64
			parent              string
			spanStart, spanEnd  int
			replacement, signal string
		)
		if err := rows.Scan(&id, &parent, &spanStart, &spanEnd, &replacement, &signal, &signalTS); err != nil {
			return correction.PersonalizationData{}, fmt.Errorf("scan pair: %w", err)
		}
		// Skip rows whose span is unrecoverable (the corrector's diff
		// never produces these, but a corrupt row must not panic the
		// aggregation path).
		if spanStart > spanEnd || spanEnd > len(parent) {
			continue
		}
		// Widen to the surrounding word and splice the replacement in.
		// The widened bounds are always inside [0, len(parent)].
		wordStart, wordEnd := correction.ExpandToWordBoundaries(parent, spanStart, spanEnd)
		pairOriginal := parent[wordStart:wordEnd]
		pairSuggestion := parent[wordStart:spanStart] + replacement + parent[spanEnd:wordEnd]
		// No-op edit: the widening turned the diff into a tautology.
		// Most commonly an allowlisted word whose replacement happened
		// to match the original at the wider boundary.
		if pairOriginal == pairSuggestion {
			continue
		}
		k := pairKey{Original: pairOriginal, Suggestion: pairSuggestion}
		// 'rejected' OR 'ignored': the browser client only ever sends
		// accepted / ignored (there is no Reject affordance), so a
		// repeated ignore IS the negative pattern. >=3 keeps one-off
		// dismissals out — applied at the flatten step.
		var m map[pairKey]*pairAgg
		if signal == "accepted" {
			m = acc
		} else {
			m = rej
		}
		agg, ok := m[k]
		if !ok {
			m[k] = &pairAgg{
				EditPair: correction.EditPair{Original: pairOriginal, Suggestion: pairSuggestion, Count: 1},
				lastTS:   signalTS,
				maxID:    id,
			}
			continue
		}
		agg.Count++
		if signalTS > agg.lastTS {
			agg.lastTS = signalTS
		}
		if id > agg.maxID {
			agg.maxID = id
		}
	}
	if err := rows.Err(); err != nil {
		return correction.PersonalizationData{}, fmt.Errorf("rows: %w", err)
	}
	return correction.PersonalizationData{
		Accepted: orderAndCapPairs(acc, 20, 1),
		Rejected: orderAndCapPairs(rej, 20, 3),
	}, nil
}

// pairKey is the (Original, Suggestion) tuple the aggregation groups by.
type pairKey struct {
	Original   string
	Suggestion string
}

// pairAgg is the per-key rollup kept on the side during the GROUP-BY-in-Go
// pass. The recency sort keys (last signal_ts, last edit id) are NOT part
// of the public PersonalizationData contract — the contract is
// {Original, Suggestion, Count} — so they live here and never escape.
type pairAgg struct {
	correction.EditPair
	lastTS int64
	maxID  int64
}

// orderAndCapPairs flattens a per-key aggregate map into the public
// EditPair slice, ordered most-recent-first (last signal_ts DESC, then
// last edit id DESC for ties) and capped at capN. Entries with
// Count < minCount are dropped first (the negative pool uses >=3 to
// suppress one-off dismissals).
func orderAndCapPairs(m map[pairKey]*pairAgg, capN, minCount int) []correction.EditPair {
	out := make([]correction.EditPair, 0, len(m))
	for _, agg := range m {
		if agg.Count < minCount {
			continue
		}
		out = append(out, agg.EditPair)
	}
	sort.Slice(out, func(i, j int) bool {
		ki := pairKey{Original: out[i].Original, Suggestion: out[i].Suggestion}
		kj := pairKey{Original: out[j].Original, Suggestion: out[j].Suggestion}
		ti, tj := m[ki].lastTS, m[kj].lastTS
		if ti != tj {
			return ti > tj
		}
		ii, ij := m[ki].maxID, m[kj].maxID
		return ii > ij
	})
	if len(out) > capN {
		out = out[:capN]
	}
	return out
}

// PruneOlderThan deletes correction events older than `days` whose edits
// carry NO user signal (signaled edits are the learning-loop training set
// and are kept indefinitely). Orphaned edits are removed with their parent.
// days <= 0 disables pruning. The corrections DB is the most sensitive file
// in the system — it holds everything the user typed — so unbounded growth
// is a privacy liability, not just a disk one.
func (s *SQLite) PruneOlderThan(days int) error {
	if days <= 0 {
		return nil
	}
	cutoff := time.Now().AddDate(0, 0, -days).UnixMilli()
	if _, err := s.db.Exec(
		`DELETE FROM corrections
		 WHERE ts < ?
		   AND id NOT IN (SELECT DISTINCT correction_id FROM edits WHERE signal IS NOT NULL)`,
		cutoff,
	); err != nil {
		return fmt.Errorf("prune corrections: %w", err)
	}
	if _, err := s.db.Exec(
		`DELETE FROM edits WHERE correction_id NOT IN (SELECT id FROM corrections)`,
	); err != nil {
		return fmt.Errorf("prune orphaned edits: %w", err)
	}
	return nil
}

// Close closes the database.
func (s *SQLite) Close() error { return s.db.Close() }
