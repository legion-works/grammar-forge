package correction

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestBritishLexiconContainsCorePairs pins the contract for the embedded
// VarCon-derived lexicon (Task E1 — bridge-quality quartet Phase E):
//
//   - the three core pairs the plan calls out (color, organize, theater)
//     each round-trip to their British equivalent;
//   - the lexicon holds more than one thousand pairs so the average
//     sentence-level protection isn't degenerate;
//   - every key is lowercase, every value differs from its key (no
//     self-pairs), and no key contains whitespace (single alphabetic
//     tokens only — multi-word compounds and POS slots are excluded
//     upstream by build-dialect-lexicon.sh).
//
// The lexicon is loaded from an embedded TSV via sync.Once, so this test
// implicitly covers the parse path too.
func TestBritishLexiconContainsCorePairs(t *testing.T) {
	lex := BritishLexicon()
	require.Equal(t, "colour", lex["color"])
	require.Equal(t, "organise", lex["organize"])
	require.Equal(t, "theatre", lex["theater"])
	require.Greater(t, len(lex), 1000)
	for us, gb := range lex {
		require.Equal(t, strings.ToLower(us), us, "lexicon key not lowercase: %q", us)
		require.NotEqual(t, us, gb, "lexicon self-pair: %q->%q", us, gb)
		require.NotContains(t, us, " ", "lexicon key contains whitespace: %q", us)
	}
}
