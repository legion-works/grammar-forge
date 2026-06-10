package ltcompat

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestByteToUTF16Offset(t *testing.T) {
	text := "café x"
	require.Equal(t, 0, byteToUTF16Offset(text, 0))
	require.Equal(t, 3, byteToUTF16Offset(text, 3))
	require.Equal(t, 4, byteToUTF16Offset(text, 5))
	require.Equal(t, 6, byteToUTF16Offset(text, 7))
}

func TestByteToUTF16OffsetSurrogatePairs(t *testing.T) {
	text := "a😀b"
	require.Equal(t, 1, byteToUTF16Offset(text, 1))
	require.Equal(t, 3, byteToUTF16Offset(text, 5))
}

func TestByteToUTF16OffsetClampsOutOfRange(t *testing.T) {
	require.Equal(t, 2, byteToUTF16Offset("ab", 99))
	require.Equal(t, 0, byteToUTF16Offset("ab", -1))
}
