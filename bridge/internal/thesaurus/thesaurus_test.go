package thesaurus_test

import (
	"testing"

	"github.com/grammarforge/bridge/internal/thesaurus"
	"github.com/stretchr/testify/require"
)

const fixturePath = "testdata/mthesaur_mini.txt"

func TestLoad_OK(t *testing.T) {
	th, err := thesaurus.Load(fixturePath)
	require.NoError(t, err)
	require.NotNil(t, th)
}

func TestLookup_KnownWord(t *testing.T) {
	th, err := thesaurus.Load(fixturePath)
	require.NoError(t, err)
	syns := th.Lookup("happy")
	require.NotEmpty(t, syns, "expected synonyms for 'happy'")
	require.LessOrEqual(t, len(syns), 8, "cap at 8 synonyms")
}

func TestLookup_UnknownWord(t *testing.T) {
	th, err := thesaurus.Load(fixturePath)
	require.NoError(t, err)
	syns := th.Lookup("xyzzy_not_a_word")
	require.Empty(t, syns)
}

func TestLookup_CaseInsensitive(t *testing.T) {
	th, err := thesaurus.Load(fixturePath)
	require.NoError(t, err)
	lower := th.Lookup("happy")
	upper := th.Lookup("Happy")
	mixed := th.Lookup("HAPPY")
	require.Equal(t, lower, upper, "Happy must match happy")
	require.Equal(t, lower, mixed, "HAPPY must match happy")
}

// "good" in the fixture has well over 8 synonyms — Lookup must cap to 8.
func TestLookup_CapAt8(t *testing.T) {
	th, err := thesaurus.Load(fixturePath)
	require.NoError(t, err)
	syns := th.Lookup("good")
	require.LessOrEqual(t, len(syns), 8, "cap at 8 synonyms")
	require.Greater(t, len(syns), 0, "fixture has synonyms for good")
}

// A thesaurus loaded from a missing file must return a working (empty) instance
// rather than erroring — the bridge boots cleanly before fetch-thesaurus.sh has
// been run.
func TestLoad_MissingFileIsEmptyNotError(t *testing.T) {
	th, err := thesaurus.Load("testdata/does_not_exist.txt")
	require.NoError(t, err, "missing dataset must not error; bridge still boots")
	require.NotNil(t, th)
	require.Empty(t, th.Lookup("happy"), "empty thesaurus returns no synonyms")
}

func TestLookup_NilSafeEmpty(t *testing.T) {
	var th *thesaurus.Thesaurus
	require.NotPanics(t, func() {
		got := th.Lookup("happy")
		require.Empty(t, got)
	})
}
