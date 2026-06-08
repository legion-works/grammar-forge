package prompt

import (
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/grammarforge/bridge/internal/personalization"
	"github.com/stretchr/testify/require"
)

// fakePersonalizer returns a configurable Block. nil blockText means empty.
type fakePersonalizer struct {
	text string
	n    int
}

func (f *fakePersonalizer) Snapshot() personalization.Block {
	f.n++
	return personalization.NewBlockForTest(f.text)
}

func TestBuildInjectsPersonalizationChat(t *testing.T) {
	pz := &fakePersonalizer{text: "\n\nLearned preferences:\nCorrect \"a\" to \"b\".\n"}
	b := NewWithPersonalizer("chat_instruct", pz)
	p := b.Build(testRequest())
	require.Equal(t, correction.TemplateChatInstruct, p.Template)
	require.Contains(t, p.System, "grammar",
		"base systemPrompt must be present")
	require.Contains(t, p.System, "Learned preferences",
		"personalization block must be appended")
	// Order: base systemPrompt FIRST, then the block.
	baseIdx := strings.Index(p.System, "grammar")
	blockIdx := strings.Index(p.System, "Learned preferences")
	require.Greater(t, blockIdx, baseIdx,
		"personalization block must come AFTER the base system prompt")
	require.Equal(t, 1, pz.n, "personalizer Snapshot called exactly once per Build")
}

func TestBuildEmptyPersonalizationUnchanged(t *testing.T) {
	pz := &fakePersonalizer{text: ""} // empty block
	b := NewWithPersonalizer("chat_instruct", pz)
	p := b.Build(testRequest())
	require.Equal(t, systemPrompt, p.System,
		"empty personalizer block must leave System byte-identical to base systemPrompt")
	require.Equal(t, 1, pz.n,
		"personalizer must be consulted on the chat path (the cache decides empty/non-empty)")
}

func TestBuildGRMRNativeNeverPersonalized(t *testing.T) {
	pz := &fakePersonalizer{text: "\n\nLearned preferences:\nCorrect \"a\" to \"b\".\n"}
	b := NewWithPersonalizer("grmr_native", pz)
	p := b.Build(testRequest())
	require.Equal(t, correction.TemplateGRMRNative, p.Template)
	require.Empty(t, p.System, "GRMR-native must never receive a system prompt")
	require.Equal(t, 0, pz.n,
		"GRMR-native Build must NOT call the personalizer (no injection target)")
}

func TestNewNoPersonalizerBackCompat(t *testing.T) {
	// New(format) must NOT call the personalizer, must NOT inject anything.
	// It must be byte-identical to the pre-personalization Build.
	b := New("chat_instruct")
	p := b.Build(testRequest())
	require.Equal(t, systemPrompt, p.System,
		"New(format) with no personalizer must produce the original systemPrompt")
}

// BuildRephrase and BuildStyle must NOT receive a personalizer call. The
// accept/reject signal log is for the GRAMMAR pass, not for rephrasing or
// picky style suggestions.
func TestBuildRephraseAndStyleDoNotCallPersonalizer(t *testing.T) {
	pz := &fakePersonalizer{text: "INJECT"}
	b := NewWithPersonalizer("chat_instruct", pz)
	_ = b.BuildRephrase(correction.RephraseRequest{Text: "x"})
	_ = b.BuildStyle(correction.Request{Text: "x"})
	require.Equal(t, 0, pz.n,
		"BuildRephrase/BuildStyle must NOT call the personalizer")
	// And rephrase/style System must NOT contain the injected text.
	rp := b.BuildRephrase(correction.RephraseRequest{Text: "x"})
	require.NotContains(t, rp.System, "INJECT")
	st := b.BuildStyle(correction.Request{Text: "x"})
	require.NotContains(t, st.System, "INJECT")
}

func testRequest() correction.Request { return correction.Request{Text: "I has a cat"} }
