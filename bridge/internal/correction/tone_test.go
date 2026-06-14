package correction

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestToneTagsVocabulary(t *testing.T) {
	require.Len(t, ToneTags, 15)
	require.True(t, allowedToneTag("frustrated"))
	require.True(t, allowedToneTag("sincere"))
	require.False(t, allowedToneTag("bogus"))
}
