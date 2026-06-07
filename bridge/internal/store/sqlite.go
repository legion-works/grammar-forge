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
	res, err := s.db.ExecContext(ctx,
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
	_, err := s.db.ExecContext(ctx,
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

// Close closes the database.
func (s *SQLite) Close() error { return s.db.Close() }
