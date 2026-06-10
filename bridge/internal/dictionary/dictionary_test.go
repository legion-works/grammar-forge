package dictionary

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func newTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "user-dict.txt"))
	require.NoError(t, err)
	return s
}

func TestEnsureFileCreatesMissing(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nested", "user-dict.txt")
	s, err := Open(p)
	require.NoError(t, err)
	require.NoError(t, s.EnsureFile())
	_, err = os.Stat(p)
	require.NoError(t, err)
}

func TestAddPersistsAndDedups(t *testing.T) {
	s := newTemp(t)
	require.NoError(t, s.EnsureFile())
	require.NoError(t, s.Add("Kubernetes"))
	require.NoError(t, s.Add("Kubernetes")) // exact dup = no-op
	require.NoError(t, s.Add("kubectl"))
	require.Equal(t, []string{"Kubernetes", "kubectl"}, s.Words())
	// persisted across a reopen
	s2, err := Open(s.path)
	require.NoError(t, err)
	require.Equal(t, []string{"Kubernetes", "kubectl"}, s2.Words())
}

func TestContainsCaseInsensitive(t *testing.T) {
	s := newTemp(t)
	require.NoError(t, s.EnsureFile())
	require.NoError(t, s.Add("Kubernetes"))
	require.True(t, s.Contains("kubernetes"))
	require.True(t, s.Contains("KUBERNETES"))
	require.False(t, s.Contains("docker"))
}

func TestRemove(t *testing.T) {
	s := newTemp(t)
	require.NoError(t, s.EnsureFile())
	require.NoError(t, s.Add("alpha"))
	require.NoError(t, s.Add("beta"))
	require.NoError(t, s.Remove("alpha"))
	require.NoError(t, s.Remove("missing")) // no-op
	require.Equal(t, []string{"beta"}, s.Words())
}

func TestValidation(t *testing.T) {
	s := newTemp(t)
	require.NoError(t, s.EnsureFile())
	for _, bad := range []string{"", "two words", "tab\tword", "#comment", string(make([]byte, 65))} {
		require.Error(t, s.Add(bad), "must reject %q", bad)
	}
}

func TestReadsExistingFileIgnoringCommentsAndBlanks(t *testing.T) {
	p := filepath.Join(t.TempDir(), "d.txt")
	require.NoError(t, os.WriteFile(p, []byte("# header\n\nfoo\n  bar  \n"), 0o644))
	s, err := Open(p)
	require.NoError(t, err)
	require.Equal(t, []string{"foo", "bar"}, s.Words())
}
