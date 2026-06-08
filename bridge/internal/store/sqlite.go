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
    signal      TEXT,
    signal_ts   INTEGER,
    context     TEXT,
    base_model  TEXT,
    adapter     TEXT
);
CREATE INDEX IF NOT EXISTS idx_signal ON corrections(signal);
CREATE INDEX IF NOT EXISTS idx_ts     ON corrections(ts);
`

// SQLite is the correction.Store implementation.
type SQLite struct {
	db *sql.DB
}

// Open opens (or creates) the database at path and ensures the schema exists.
func Open(path string) (*SQLite, error) {
	db, err := sql.Open("sqlite", path)
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

// LogCorrection inserts an event and returns its row id.
func (s *SQLite) LogCorrection(ctx context.Context, ev correction.Event) (int64, error) {
	res, err := s.db.ExecContext(
		ctx,
		`INSERT INTO corrections (ts, source, original, suggestion, model, rule_id, context, base_model, adapter)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UnixMilli(), string(ev.Source), ev.Original, ev.Suggestion,
		string(ev.Model), ev.RuleID, ev.Context, ev.BaseModel, ev.Adapter,
	)
	if err != nil {
		return 0, fmt.Errorf("insert correction: %w", err)
	}
	return res.LastInsertId()
}

// LogSignal records a user reaction. Unknown ids are a no-op (not an error).
func (s *SQLite) LogSignal(ctx context.Context, correctionID int64, signal correction.Signal) error {
	_, err := s.db.ExecContext(
		ctx,
		`UPDATE corrections SET signal = ?, signal_ts = ? WHERE id = ?`,
		string(signal), time.Now().UnixMilli(), correctionID,
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

// PersonalizationExamples aggregates the signal log into the few-shot pairs
// the prompt builder injects into the chat system prompt. Accepted pairs
// are ordered most-recent-first; rejected pairs are filtered to Count>=3
// and ordered by frequency (most-rejected first). Both sets are capped at
// 20 rows. Rows with signal IS NULL (no user reaction) are ignored.
func (s *SQLite) PersonalizationExamples(ctx context.Context) (correction.PersonalizationData, error) {
	accepted, err := s.queryEditPairs(ctx,
		`SELECT original, suggestion, COUNT(*) c
		 FROM corrections
		 WHERE signal = 'accepted'
		 GROUP BY original, suggestion
		 ORDER BY MAX(ts) DESC, MAX(id) DESC
		 LIMIT 20`)
	if err != nil {
		return correction.PersonalizationData{}, fmt.Errorf("accepted pairs: %w", err)
	}
	rejected, err := s.queryEditPairs(ctx,
		`SELECT original, suggestion, COUNT(*) c
		 FROM corrections
		 WHERE signal = 'rejected'
		 GROUP BY original, suggestion
		 HAVING c >= 3
		 ORDER BY c DESC
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

// Close closes the database.
func (s *SQLite) Close() error { return s.db.Close() }
