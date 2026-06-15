// Package store persists correction events and signals in SQLite via the pure-Go
// modernc.org/sqlite driver (no CGo). It implements correction.Store.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"
	"unicode"

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
CREATE INDEX IF NOT EXISTS idx_edits_category   ON edits(category);
CREATE INDEX IF NOT EXISTS idx_edits_signal ON edits(signal);
CREATE TABLE IF NOT EXISTS tone_signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text_hash  TEXT NOT NULL,
    tags_json  TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tone_signals_text_hash ON tone_signals(text_hash);
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

// LogTone inserts a tone-analysis event into the tone_signals table. Best-
// effort signal log: tags are stored as a JSON array (lowercase, fixed
// vocabulary enforced by the parser before we get here). Errors surface to
// the caller; the service layer swallows them so /tone never fails on log
// problems.
func (s *SQLite) LogTone(ctx context.Context, ev correction.ToneEvent) error {
	tagsJSON, err := json.Marshal(ev.Tags)
	if err != nil {
		return fmt.Errorf("log tone: marshal tags: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO tone_signals (text_hash, tags_json, target, source) VALUES (?, ?, ?, ?)`,
		ev.TextHash, string(tagsJSON), ev.Target, string(ev.Source))
	if err != nil {
		return fmt.Errorf("log tone: insert: %w", err)
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

// CountStatsExtended computes the retention field block for /stats:
// top_issues, streak, and words_this_week. `now` is the reference time —
// the production caller passes time.Now(), tests pin it to a synthetic
// date so the streak and 7d window are deterministic.
//
// Algorithms:
//   - top_issues: GROUP BY edits.category, ordered by count DESC, category
//     ASC as a stable tiebreak. COALESCE makes NULL categories surface as
//     "" (the CategoryGrammar value). Every edit counts, including those
//     with signal IS NULL — "what the corrector flagged" is the habit
//     signal, not "what the user accepted".
//   - streak: list distinct UTC days with at least one correction in the
//     last 365 days, ordered DESC; count consecutive days starting at
//     the `now` day. A gap of >=1 day breaks the chain. 0 when `now`'s
//     day is not active. The 365-day cap bounds the in-memory work for
//     power users with multi-year histories.
//   - words_this_week: sum of whitespace-delimited word counts of
//     corrections.suggestion in the inclusive 7d window
//     [now-7d, now]. APPROXIMATE: exact for the rows in the window, but
//     computed at query time (no precomputed word_count column). A
//     dedicated `word_count INTEGER` column on corrections, set at
//     LogCorrection time, would make this O(1) and would also surface
//     checked-but-uncorrected sentences that never get a corrections
//     row. Documented on correction.StatsExtended.
func (s *SQLite) CountStatsExtended(ctx context.Context, now time.Time) (correction.StatsExtended, error) {
	out := correction.StatsExtended{
		TopIssues:     []correction.CategoryCount{},
		WordsThisWeek: 0,
	}

	// top_issues — one query, scan into the result. COALESCE keeps NULL
	// (an unsignaled edit whose category was never set) as "" in the
	// output so clients can render it as the grammar bucket.
	rows, err := s.db.QueryContext(ctx, `
		SELECT COALESCE(category, ''), COUNT(*)
		FROM edits
		GROUP BY COALESCE(category, '')
		ORDER BY COUNT(*) DESC, COALESCE(category, '') ASC`)
	if err != nil {
		return correction.StatsExtended{}, fmt.Errorf("count top_issues: %w", err)
	}
	for rows.Next() {
		var cc correction.CategoryCount
		if err := rows.Scan(&cc.Category, &cc.Count); err != nil {
			_ = rows.Close()
			return correction.StatsExtended{}, fmt.Errorf("scan top_issues: %w", err)
		}
		out.TopIssues = append(out.TopIssues, cc)
	}
	if err := rows.Err(); err != nil {
		return correction.StatsExtended{}, fmt.Errorf("rows top_issues: %w", err)
	}
	_ = rows.Close()

	// streak — distinct UTC days with at least one correction in the last
	// 365 days. The Go-side chain walk keeps the query trivial (a single
	// index hit on corrections.ts) and the per-row work bounded by the
	// 365-day cap, not by the full log size.
	nowDay := now.UTC().Truncate(24 * time.Hour)
	cutoffMs := now.AddDate(0, 0, -365).UnixMilli()
	dayRows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT (ts / 86400000)
		FROM corrections
		WHERE ts >= ?
		ORDER BY (ts / 86400000) DESC`,
		cutoffMs)
	if err != nil {
		return correction.StatsExtended{}, fmt.Errorf("count streak days: %w", err)
	}
	defer func() { _ = dayRows.Close() }()
	// Use a set of day-since-epoch ints (UTC midnight) so the chain walk
	// is O(N) without sorting (the SQL already returned them DESC). The
	// streak starts at the `now` day; a gap of >=1 day terminates the
	// walk immediately.
	streak := 0
	expected := nowDay.UnixMilli() / 86400000
	chainBroken := false
	for !chainBroken && dayRows.Next() {
		var dayEpoch int64
		if err := dayRows.Scan(&dayEpoch); err != nil {
			return correction.StatsExtended{}, fmt.Errorf("scan streak day: %w", err)
		}
		gap := int(expected - dayEpoch)
		switch gap {
		case 0:
			streak++
		case streak:
			// dayEpoch = nowDay - streak; we already counted `streak` days
			// (today, today-1, ..., today-(streak-1)), so this extends the
			// chain by 1.
			streak++
		default:
			// Either `now` is not active (gap > streak) or the chain just
			// broke. The DESC ordering means the first non-matching row
			// terminates the walk.
			_ = dayRows.Close()
			chainBroken = true
		}
	}
	if err := dayRows.Err(); err != nil {
		return correction.StatsExtended{}, fmt.Errorf("rows streak days: %w", err)
	}
	out.Streak = streak

	// words_this_week — sum of whitespace-delimited word counts of
	// corrections.suggestion in the inclusive 7d window. The Go-side
	// strings.Fields keeps the SQL trivial (a single index hit on
	// corrections.ts) at the cost of an in-process scan of the
	// windowed rows. A dedicated word_count column would replace the
	// scan with a SUM.
	weekStartMs := now.AddDate(0, 0, -7).UnixMilli()
	weekRows, err := s.db.QueryContext(ctx,
		`SELECT suggestion FROM corrections WHERE ts >= ?`, weekStartMs)
	if err != nil {
		return correction.StatsExtended{}, fmt.Errorf("count words_this_week: %w", err)
	}
	defer func() { _ = weekRows.Close() }()
	for weekRows.Next() {
		var text string
		if err := weekRows.Scan(&text); err != nil {
			return correction.StatsExtended{}, fmt.Errorf("scan words_this_week: %w", err)
		}
		// Count tokens using the same whitespace rule the LLM sees in
		// the prompt: split on unicode.IsSpace, drop empty tokens.
		// A precomputed word_count column would replace this with a
		// single SQL SUM.
		out.WordsThisWeek += int64(countWords(text))
	}
	if err := weekRows.Err(); err != nil {
		return correction.StatsExtended{}, fmt.Errorf("rows words_this_week: %w", err)
	}

	return out, nil
}

// countWords is a whitespace-delimited word counter used by
// CountStatsExtended. A precomputed word_count column on corrections
// would let the SQL SUM it directly; until then, this is the
// in-process fallback. Matches unicode.IsSpace semantics — the
// production LLM prompts split on the same boundary.
func countWords(s string) int {
	n := 0
	inWord := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if inWord {
				n++
				inWord = false
			}
			continue
		}
		inWord = true
	}
	if inWord {
		n++
	}
	return n
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
