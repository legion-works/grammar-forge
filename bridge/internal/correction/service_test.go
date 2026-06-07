package correction

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeLLM struct {
	out string
	err error
}

func (f fakeLLM) Complete(context.Context, Prompt) (string, error) { return f.out, f.err }

type fakePB struct{}

func (fakePB) Build(req Request) Prompt { return Prompt{User: req.Text, Template: TemplateGRMRNative} }

type fakeStore struct {
	lastEvent  Event
	lastSignal Signal
	lastID     int64
	count      int64
}

func (f *fakeStore) LogCorrection(_ context.Context, ev Event) (int64, error) {
	f.lastEvent = ev
	f.count++
	return 42, nil
}

func (f *fakeStore) LogSignal(_ context.Context, id int64, s Signal) error {
	f.lastID, f.lastSignal = id, s
	return nil
}
func (f *fakeStore) CountCorrections(context.Context) (int64, error) { return f.count, nil }
func (f *fakeStore) Close() error                                    { return nil }

func TestServiceCorrectLogsAndTagsSuggestions(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, fakeLLM{out: "I have a cat"}, st, "grmr-test")
	got, err := svc.Correct(context.Background(), Request{Text: "I has a cat", Source: SourceVencord})
	require.NoError(t, err)
	require.Len(t, got.Suggestions, 1)
	require.Equal(t, int64(42), got.Suggestions[0].ID) // tagged with the logged id
	require.Equal(t, "I has a cat", st.lastEvent.Original)
	require.Equal(t, "I have a cat", st.lastEvent.Suggestion)
	require.Equal(t, "grmr-test", st.lastEvent.BaseModel)
	require.Equal(t, int64(1), st.count)
}

func TestServiceCorrectNoChangeDoesNotLog(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, fakeLLM{out: "all good"}, st, "m")
	got, err := svc.Correct(context.Background(), Request{Text: "all good"})
	require.NoError(t, err)
	require.Empty(t, got.Suggestions)
	require.Equal(t, 100, got.Score)
	require.Equal(t, int64(0), st.count) // nothing to learn from
}

func TestServiceCorrectSurfacesLLMError(t *testing.T) {
	svc := NewService(fakePB{}, fakeLLM{err: errors.New("down")}, &fakeStore{}, "m")
	_, err := svc.Correct(context.Background(), Request{Text: "x"})
	require.Error(t, err)
}

func TestServiceSignal(t *testing.T) {
	st := &fakeStore{}
	svc := NewService(fakePB{}, fakeLLM{}, st, "m")
	require.NoError(t, svc.Signal(context.Background(), 7, SignalAccepted))
	require.Equal(t, int64(7), st.lastID)
	require.Equal(t, SignalAccepted, st.lastSignal)
	require.Error(t, svc.Signal(context.Background(), 7, Signal("bogus"))) // invalid enum
}
