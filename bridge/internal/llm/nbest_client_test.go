package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

// ---- n_param wire strategy ----

func TestCompleteN_NParam_SingleRequestCarriesN(t *testing.T) {
	for _, tc := range []struct {
		name string
		tmpl correction.PromptTemplate
		resp string
	}{
		{"chat", correction.TemplateChatInstruct, `{"choices":[{"message":{"content":"a"}},{"message":{"content":"b"}}]}`},
		{"completions", correction.TemplateGRMRNative, `{"choices":[{"text":"a"},{"text":"b"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls int32
			var gotBody map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				atomic.AddInt32(&calls, 1)
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				_, _ = w.Write([]byte(tc.resp))
			}))
			defer srv.Close()
			c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "n_param"})
			out, err := c.CompleteN(context.Background(), correction.Prompt{
				System: "sys", User: "txt", Template: tc.tmpl, Temperature: 0.3,
			}, 2)
			require.NoError(t, err)
			require.Equal(t, int32(1), atomic.LoadInt32(&calls), "n_param strategy must issue exactly ONE request")
			require.Equal(t, []string{"a", "b"}, out)
			n, ok := gotBody["n"]
			require.True(t, ok, "payload must carry the n parameter")
			require.EqualValues(t, 2, n)
			require.InDelta(t, 0.3, gotBody["temperature"], 1e-9)
		})
	}
}

func TestCompleteN_NParam_RejectsTruncatedAndEmptyChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[
			{"text":"good"},
			{"text":"partial","finish_reason":"length"},
			{"text":""},
			{"text":"also good"}
		]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "n_param"})
	out, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 4)
	require.NoError(t, err)
	require.Equal(t, []string{"good", "also good"}, out, "truncated and empty choices must be rejected, not surfaced as candidates")
}

func TestCompleteN_NParam_AllChoicesInvalidReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"text":"partial","finish_reason":"length"},{"text":""}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "n_param"})
	_, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 2)
	require.Error(t, err)
}

func TestCompleteN_NParam_FewerChoicesThanRequestedReturnsSubsetNoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"text":"only-one"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "n_param"})
	out, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 3)
	require.NoError(t, err)
	require.Equal(t, []string{"only-one"}, out)
}

// ---- sequential wire strategy (default) ----

func TestCompleteN_Sequential_IssuesNRequestsWithDistinctSeeds(t *testing.T) {
	for _, tc := range []struct {
		name string
		tmpl correction.PromptTemplate
		resp string
	}{
		{"chat", correction.TemplateChatInstruct, `{"choices":[{"message":{"content":"cand"}}]}`},
		{"completions", correction.TemplateGRMRNative, `{"choices":[{"text":"cand"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var seedsSeen []float64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				seedsSeen = append(seedsSeen, body["seed"].(float64))
				_, _ = w.Write([]byte(tc.resp))
			}))
			defer srv.Close()
			c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", Seed: 10, NBestWire: "sequential"})
			out, err := c.CompleteN(context.Background(), correction.Prompt{
				System: "sys", User: "txt", Template: tc.tmpl,
			}, 3)
			require.NoError(t, err)
			require.Len(t, out, 3)
			require.Equal(t, []float64{10, 11, 12}, seedsSeen, "sequential must use seed, seed+1, seed+2 in order")
		})
	}
}

func TestCompleteN_Sequential_DefaultWireIsSequential(t *testing.T) {
	// NBestWire left unset ("") must behave as "sequential" (the portable
	// BYO-safe default) — mirrors config.go's GF_LLM_NBEST_WIRE default.
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(`{"choices":[{"text":"cand"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	out, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 2)
	require.NoError(t, err)
	require.Len(t, out, 2)
	require.Equal(t, int32(2), atomic.LoadInt32(&calls), "default (empty) NBestWire must behave as sequential (2 requests for n=2)")
}

func TestCompleteN_Sequential_PartialFailureReturnsSubset(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 2 {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"text":"cand"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "sequential"})
	c.SetRetryConfig(RetryConfig{Enabled: false}) // isolate from the retry layer
	out, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 3)
	require.NoError(t, err, "at least one candidate succeeded; partial failure must not surface as an error")
	require.Len(t, out, 2, "2 of 3 requests succeeded")
}

func TestCompleteN_Sequential_ZeroSuccessReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "sequential"})
	c.SetRetryConfig(RetryConfig{Enabled: false})
	_, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 3)
	require.Error(t, err)
}

func TestCompleteN_Sequential_RejectsTruncatedCandidate(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"text":"partial","finish_reason":"length"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"text":"good"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "sequential"})
	out, err := c.CompleteN(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative}, 2)
	require.NoError(t, err)
	require.Equal(t, []string{"good"}, out, "the truncated candidate must be rejected, leaving only the good one")
}

// Complete (the single-candidate legacy path) must stay byte-identical:
// n_param/NBestWire must never leak an "n" key onto the legacy payload.
func TestComplete_NeverCarriesNParameterRegardlessOfNBestWire(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"text":"ok"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", NBestWire: "n_param"})
	_, err := c.Complete(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative})
	require.NoError(t, err)
	_, present := gotBody["n"]
	require.False(t, present, "the legacy Complete path must never send n, even when NBestWire is n_param")
}
