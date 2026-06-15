// Package thesaurus provides offline synonym lookup backed by the
// Moby Thesaurus II dataset (Grady Ward, 1996, public domain). The
// flat-file dataset is loaded once at startup into an in-memory map;
// lookups are O(1) map reads.
//
// The dataset is intentionally NOT bundled with the bridge — the
// ~10 MB file is fetched at deploy time via scripts/fetch-thesaurus.sh
// and mounted at GF_THESAURUS_PATH (default /data/mthesaur.txt), so
// the binary stays small and the data file is easy to swap/regenerate.
// When the file is absent the bridge still boots and /synonyms returns
// an empty list (the route is on the wire, just with no payload).
package thesaurus

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"strings"
)

// maxSynonyms caps the number of synonyms returned per word. The
// dataset has thousands per root for common words; clients only need
// a handful for the popup UI, and capping at load time keeps the map
// memory-bounded without a separate truncation step on every lookup.
const maxSynonyms = 8

// Thesaurus is the in-memory synonym map. The zero value is invalid
// for direct use; always go through Load so a nil map is replaced with
// an empty (writable) one. Lookup on a nil *Thesaurus is safe (returns
// nil) so handlers can call it before SetThesaurus has fired.
type Thesaurus struct {
	data map[string][]string // lowercase word → up to maxSynonyms synonyms
}

// Load parses a Moby-format file (one entry per line: "word,syn1,syn2,...").
// A missing file is NOT an error — it returns an empty Thesaurus so the
// bridge starts cleanly when the dataset has not been fetched yet. Any
// other I/O or parse error is returned verbatim.
func Load(path string) (*Thesaurus, error) {
	th := &Thesaurus{data: make(map[string][]string, 30000)}
	f, err := os.Open(path) //nolint:gosec // path is operator-controlled (env/flag)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return th, nil
		}
		return nil, err
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	// Moby lines can be long (~20 KB in the worst case); raise the scanner
	// buffer to handle them. The default 64 KB is enough for every line
	// in the real dataset, but use 1 MB for headroom against future
	// expansions.
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		// Only the FIRST comma separates the headword from its synonym
		// list — a synonym may legitimately contain a comma (rare, but
		// split-on-every-comma would corrupt the list).
		parts := strings.SplitN(line, ",", 2)
		if len(parts) < 2 {
			continue
		}
		word := strings.ToLower(strings.TrimSpace(parts[0]))
		if word == "" {
			continue
		}
		raw := strings.Split(parts[1], ",")
		syns := make([]string, 0, maxSynonyms)
		for _, s := range raw {
			s = strings.TrimSpace(s)
			// Drop empties and the headword itself (Moby sometimes
			// includes the headword in its own synonym list).
			if s == "" || strings.EqualFold(s, word) {
				continue
			}
			syns = append(syns, s)
			if len(syns) == maxSynonyms {
				break
			}
		}
		th.data[word] = syns
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return th, nil
}

// Lookup returns up to maxSynonyms synonyms for word (case-insensitive).
// Returns nil for unknown words. Safe to call on a nil *Thesaurus —
// returns nil without panicking — so handlers wired before the dataset
// loads still respond cleanly.
func (t *Thesaurus) Lookup(word string) []string {
	if t == nil || t.data == nil {
		return nil
	}
	return t.data[strings.ToLower(word)]
}

// Size reports how many headwords are loaded. Useful for boot logging
// ("loaded 30000 headwords") and for tests; not part of the wire API.
func (t *Thesaurus) Size() int {
	if t == nil {
		return 0
	}
	return len(t.data)
}
