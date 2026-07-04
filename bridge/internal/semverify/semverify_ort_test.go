//go:build cgo && ORT

package semverify

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestNewFailsCleanlyOnMissingModel asserts that New() returns a non-nil error
// (and does not panic) when the model directory is absent. Runtime coverage
// of the error path so a regression in hugot.LoadModel's error wrapping is
// caught even when model weights are not present.
//
// Full end-to-end similarity testing happens via cmd/semverify-probe (C4):
// that binary reads eval/overedit_fixtures.jsonl + golden pairs and prints
// cosine per row, against the REAL model in Docker. Here we exercise only the
// load-failure contract — the path the bridge takes when the operator forgot
// to run scripts/fetch-models.sh or pointed GF_SEMANTIC_VERIFIER_MODEL_PATH
// at a missing dir.
func TestNewFailsCleanlyOnMissingModel(t *testing.T) {
	require.NotPanics(t, func() {
		v, err := New("/nonexistent/path")
		require.Error(t, err, "New on a missing model dir must return an error")
		require.Nil(t, v, "verifier must be nil when construction fails")
	})
}