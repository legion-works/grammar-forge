// Package dictionary is the on-disk user dictionary file the bridge exposes
// to both Harper (via the harperffi merged-dict watcher) and the correction
// service's LLM allowlist.
//
// One file, two consumers, kept in sync by reading the file's mtime on every
// read call: external edits (hand-edits, the future browser-extension button,
// tooling) are picked up without a restart. Writes are atomic — a temp file
// in the same directory is fully written, fsynced, and renamed onto the
// target, so concurrent readers always see a complete snapshot.
//
// File format: one word per line. Blank lines and lines starting with '#'
// are ignored. Word validation: non-empty, ≤maxWordLen bytes, single token
// (no whitespace), valid UTF-8. Case-insensitive membership.
package dictionary

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

// maxWordLen is the per-word cap. 64 bytes covers every common word in any
// natural language we accept, and bounds the rewrite window for a single
// atomic rename.
const maxWordLen = 64

// Store is the user-dictionary file as a goroutine-safe in-memory list. Safe
// for concurrent use.
type Store struct {
	path  string
	mu    sync.Mutex
	words []string
	set   map[string]struct{}
	mtime int64
}

// Open opens (but does NOT create) the dictionary file at path. A missing
// file is fine — the store starts empty; the caller may EnsureFile.
func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("dictionary: empty path")
	}
	s := &Store{
		path: path,
		set:  make(map[string]struct{}),
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		s.mtime = info.ModTime().UnixNano()
		if err := s.load(); err != nil {
			return nil, err
		}
	case errors.Is(err, os.ErrNotExist):
		// empty store; nothing to do
	default:
		return nil, fmt.Errorf("dictionary: stat: %w", err)
	}
	return s, nil
}

// EnsureFile creates the file (and any missing parent directories) if it does
// not already exist. Idempotent; existing files are untouched.
func (s *Store) EnsureFile() error {
	if dir := filepath.Dir(s.path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("dictionary: mkdir: %w", err)
		}
	}
	f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("dictionary: create: %w", err)
	}
	return f.Close()
}

// load reads the file at s.path, replacing the in-memory state. Caller must
// hold s.mu.
func (s *Store) load() error {
	f, err := os.Open(s.path)
	if err != nil {
		return fmt.Errorf("dictionary: open: %w", err)
	}
	defer func() { _ = f.Close() }()

	words := make([]string, 0)
	set := make(map[string]struct{})
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if err := validate(line); err != nil {
			// Forgiving on read: hand-edited files may carry historical
			// cruft; new writes still go through Add's strict validation.
			continue
		}
		lower := strings.ToLower(line)
		if _, dup := set[lower]; dup {
			continue
		}
		set[lower] = struct{}{}
		words = append(words, line)
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("dictionary: scan: %w", err)
	}
	s.words = words
	s.set = set
	return nil
}

// validate rejects empty, oversized, whitespace-bearing, comment-prefixed,
// and not-valid-UTF-8 words. Single token, ≤maxWordLen bytes.
func validate(word string) error {
	if word == "" {
		return errors.New("word is empty")
	}
	if len(word) > maxWordLen {
		return fmt.Errorf("word exceeds %d bytes", maxWordLen)
	}
	if strings.HasPrefix(word, "#") {
		return errors.New("word starts with #")
	}
	if strings.ContainsAny(word, " \t\n\r") {
		return errors.New("word contains whitespace")
	}
	if !utf8.ValidString(word) {
		return errors.New("word is not valid UTF-8")
	}
	return nil
}

// Add appends a word, deduplicating case-insensitively. Writes the file
// atomically; on success the in-memory state mirrors the new file.
func (s *Store) Add(word string) error {
	if err := validate(word); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	lower := strings.ToLower(word)
	if _, dup := s.set[lower]; dup {
		return nil
	}
	s.set[lower] = struct{}{}
	s.words = append(s.words, word)
	return s.rewriteLocked()
}

// Remove deletes the word (case-insensitive) from the store. Missing words
// are a no-op (idempotent). Writes the file atomically.
func (s *Store) Remove(word string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	lower := strings.ToLower(word)
	for i, w := range s.words {
		if strings.ToLower(w) == lower {
			s.words = append(s.words[:i], s.words[i+1:]...)
			delete(s.set, lower)
			return s.rewriteLocked()
		}
	}
	return nil
}

// Words returns a copy of the in-memory word list in file order. If the
// file's mtime has changed since the last read (e.g. an external editor
// modified it), the in-memory state is reloaded first.
func (s *Store) Words() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshLocked()
	out := make([]string, len(s.words))
	copy(out, s.words)
	return out
}

// Contains reports whether word is in the store (case-insensitive).
func (s *Store) Contains(word string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshLocked()
	_, ok := s.set[strings.ToLower(word)]
	return ok
}

// refreshLocked reloads the file into memory if its mtime has changed since
// the last read. Best-effort: on error, keep the stale in-memory state.
// Caller must hold s.mu.
func (s *Store) refreshLocked() {
	info, err := os.Stat(s.path)
	if err != nil {
		return
	}
	if info.ModTime().UnixNano() == s.mtime {
		return
	}
	if err := s.load(); err != nil {
		return
	}
	s.mtime = info.ModTime().UnixNano()
}

// rewriteLocked writes the current in-memory word list to a temp file in the
// same directory, fsyncs it, and renames it onto the target. Atomic on POSIX.
// Caller must hold s.mu.
func (s *Store) rewriteLocked() error {
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".user-dict.*.tmp")
	if err != nil {
		return fmt.Errorf("dictionary: create temp: %w", err)
	}
	tmpName := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpName) }

	for _, w := range s.words {
		if _, err := tmp.WriteString(w + "\n"); err != nil {
			_ = tmp.Close()
			cleanup()
			return fmt.Errorf("dictionary: write: %w", err)
		}
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		cleanup()
		return fmt.Errorf("dictionary: sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("dictionary: close: %w", err)
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		cleanup()
		return fmt.Errorf("dictionary: rename: %w", err)
	}
	if info, err := os.Stat(s.path); err == nil {
		s.mtime = info.ModTime().UnixNano()
	}
	return nil
}
