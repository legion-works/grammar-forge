//go:build cgo

package harperffi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// writeDict writes a newline-delimited word list to a temp file and returns its
// path. Each call uses t.TempDir so the file is cleaned up automatically.
func writeDict(t *testing.T, words string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "user_dictionary.txt")
	require.NoError(t, os.WriteFile(path, []byte(words), 0o600))
	return path
}

// TestHarperUserDict_SuppressesCoinedWord is a real-Harper golden test for
// Task 6: a coined token ("qwzx") that the curated dictionary flags as a
// spelling error must NOT be flagged once it is in the user dictionary, while a
// control with no dictionary still flags it.
func TestHarperUserDict_SuppressesCoinedWord(t *testing.T) {
	const text = "I use qwzx daily."
	// "qwzx" occupies bytes [6,10).
	require.Equal(t, "qwzx", text[6:10])

	// Control: no user dict -> the coined word IS flagged.
	control := NewWithOptions(Options{Markdown: false})
	defer control.Close()
	got, err := control.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.True(t, flagsWord(got, 6, 10),
		"sanity: without a user dict the coined word should be flagged; got %+v", got)

	// With the coined word in the user dictionary -> NOT flagged.
	path := writeDict(t, "# user words\nGrammarForge\nqwzx\n")
	h := NewWithOptions(Options{Markdown: false, UserDictPath: path})
	defer h.Close()
	got, err = h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.False(t, flagsWord(got, 6, 10),
		"the user-dictionary word must not be flagged as a spelling error; got %+v", got)
}

// TestHarperUserDict_MissingPathIsCuratedOnly verifies a non-existent user dict
// path constructs fine and behaves like curated-only (no crash; the coined word
// is still flagged).
func TestHarperUserDict_MissingPathIsCuratedOnly(t *testing.T) {
	const text = "I use qwzx daily."
	h := NewWithOptions(Options{Markdown: false, UserDictPath: "/nonexistent/user_dictionary.txt"})
	defer h.Close()
	got, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.True(t, flagsWord(got, 6, 10),
		"a missing user dict must behave as curated-only and still flag the coined word; got %+v", got)
}

// TestHarperUserDict_HotReload verifies the watcher rebuilds the LintGroup when
// the user dictionary file changes: a word flagged at first is no longer flagged
// after it is appended to the dictionary. Run with -race to guard the swap.
func TestHarperUserDict_HotReload(t *testing.T) {
	const text = "I use qwzx daily."
	path := writeDict(t, "# user words\n") // starts empty (no qwzx)

	// Short per-instance poll interval so the test does not wait multiple 5s
	// ticks (no shared global mutation -> no race with other tests' watchers).
	h := newWithPollInterval(Options{Markdown: false, UserDictPath: path}, 50*time.Millisecond)
	defer h.Close()

	got, err := h.Correct(context.Background(), correction.Request{Text: text})
	require.NoError(t, err)
	require.True(t, flagsWord(got, 6, 10),
		"before reload the coined word should be flagged; got %+v", got)

	// Append the coined word; bump mtime explicitly so the poll detects the
	// change even on coarse-resolution filesystems.
	require.NoError(t, os.WriteFile(path, []byte("# user words\nqwzx\n"), 0o600))
	future := time.Now().Add(2 * time.Second)
	require.NoError(t, os.Chtimes(path, future, future))

	// Poll for the reload to take effect (the watcher ticks every 50ms here).
	require.Eventually(t, func() bool {
		got, err := h.Correct(context.Background(), correction.Request{Text: text})
		return err == nil && !flagsWord(got, 6, 10)
	}, 5*time.Second, 50*time.Millisecond,
		"after appending the word to the user dict, the hot-reload must stop flagging it")
}
