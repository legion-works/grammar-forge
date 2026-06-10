// Package store persists correction events and signals in SQLite via the pure-Go
// modernc.org/sqlite driver (no CGo). It implements correction.Store.
package store

import (
	"context"
	"database/sql"
	"fmt"
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
// the prompt builder injects into the chat system prompt. Both accepted
// and rejected pairs are ordered most-recent-first (MAX(ts) DESC, then
// MAX(id) DESC for deterministic ties within the same millisecond) so the
// few-shot block reflects the user's LATEST preferences, not the loudest.
// Rejected pairs are filtered to Count>=3 (a single reject is not a strong
// signal; three is a pattern). Both sets are capped at 20 rows. Rows with
// signal IS NULL (no user reaction) are ignored on both paths.
func (s *SQLite) PersonalizationExamples(ctx context.Context) (correction.PersonalizationData, error) {
	accepted, err := s.queryEditPairs(ctx,
		`SELECT original, replacement, COUNT(*) c
		 FROM edits
		 WHERE signal = 'accepted'
		 GROUP BY original, replacement
		 ORDER BY MAX(signal_ts) DESC, MAX(id) DESC
		 LIMIT 20`)
	if err != nil {
		return correction.PersonalizationData{}, fmt.Errorf("accepted pairs: %w", err)
	}
	// 'rejected' OR 'ignored': the browser client only ever sends accepted /
	// ignored (there is no Reject affordance), so a repeated ignore IS the
	// negative pattern. >=3 keeps one-off dismissals out.
	rejected, err := s.queryEditPairs(ctx,
		`SELECT original, replacement, COUNT(*) c
		 FROM edits
		 WHERE signal IN ('rejected', 'ignored')
		 GROUP BY original, replacement
		 HAVING c >= 3
		 ORDER BY MAX(signal_ts) DESC, MAX(id) DESC
		 LIMIT 20`)
	if err != nil {
		return correction.PersonalizationData{}, fmt.Errorf("rejected pairs: %w", err)
	}
	return correction.PersonalizationData{Accepted: accepted, Rejected: rejected}, nil
}

func (s *SQLite) queryEditPairs(ctx context.Context, query string) ([]correction.EditPair, error) {
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []correction.EditPair
	for rows.Next() {
		var p correction.EditPair
		if err := rows.Scan(&p.Original, &p.Suggestion, &p.Count); err != nil {
			return nil, fmt.Errorf("scan: %w", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows: %w", err)
	}
	return out, nil
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
