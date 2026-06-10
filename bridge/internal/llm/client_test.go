package llm

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/grammarforge/bridge/internal/correction"
	"github.com/stretchr/testify/require"
)

func TestCompleteGRMRNativeHitsCompletions(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"text": "I have a cat"}},
		})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL + "/v1", Model: "grmr"})
	out, err := c.Complete(context.Background(), correction.Prompt{
		User:     "<|text_start|>\nI has a cat<|text_end|>\n<|corrected_start|>\n",
		Stop:     []string{"<|corrected_end|>"},
		Template: correction.TemplateGRMRNative,
	})
	require.NoError(t, err)
	require.Equal(t, "I have a cat", out)
	require.Equal(t, "/v1/completions", gotPath)
	require.Contains(t, gotBody, "text_start")
}

func TestCompleteChatHitsChatCompletions(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": "I have a cat"}}},
		})
	}))
	defer srv.Close()

	c := New(Config{BaseURL: srv.URL + "/v1", Model: "qwen"})
	out, err := c.Complete(context.Background(), correction.Prompt{
		System: "be a corrector", User: "I has a cat", Template: correction.TemplateChatInstruct,
	})
	require.NoError(t, err)
	require.Equal(t, "I have a cat", out)
	require.Equal(t, "/v1/chat/completions", gotPath)
}

func TestCompleteSurfacesHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	_, err := c.Complete(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative})
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "500"))
}

func TestCompleteSendsAuthorizationHeaderWhenAPIKeySet(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"text": "ok"}},
		})
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", APIKey: "secret-key"})
	_, err := c.Complete(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative})
	require.NoError(t, err)
	require.Equal(t, "Bearer secret-key", gotAuth)
}

func TestCompleteOmitsAuthorizationHeaderWhenNoAPIKey(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"text": "ok"}},
		})
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	_, err := c.Complete(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative})
	require.NoError(t, err)
	require.Empty(t, gotAuth)
}

func TestCompleteErrorsOnEmptyChoices(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{},
		})
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	_, err := c.Complete(context.Background(), correction.Prompt{User: "x", Template: correction.TemplateGRMRNative})
	require.Error(t, err)
	require.Contains(t, err.Error(), "no choices")
}

func TestComplete_ChatSendsEnableThinkingFalse(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	_, err := c.Complete(context.Background(), correction.Prompt{
		System: "sys", User: "txt", Template: correction.TemplateChatInstruct,
	})
	require.NoError(t, err)
	kwargs, ok := gotBody["chat_template_kwargs"].(map[string]any)
	require.True(t, ok, "chat payload must carry chat_template_kwargs")
	require.Equal(t, false, kwargs["enable_thinking"])
}

func TestComplete_CompletionsOmitsChatTemplateKwargs(t *testing.T) {
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"text":"ok"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	_, err := c.Complete(context.Background(), correction.Prompt{
		User: "txt", Template: correction.TemplateGRMRNative,
	})
	require.NoError(t, err)
	_, present := gotBody["chat_template_kwargs"]
	require.False(t, present, "completions payload must NOT carry chat_template_kwargs")
}

// A finish_reason of "length" means the backend hit max_tokens and the
// output is TRUNCATED. Returning the partial text would let the diff layer
// convert the missing tail into mass-deletion suggestions (verified data-loss
// bug, 2026-06-10), so Complete must surface an error instead.
func TestCompleteErrorsOnTruncatedOutput(t *testing.T) {
	for _, tc := range []struct {
		name string
		tmpl correction.PromptTemplate
		resp string
	}{
		{
			"chat", correction.TemplateChatInstruct,
			`{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}`,
		},
		{
			"completions", correction.TemplateGRMRNative,
			`{"choices":[{"text":"partial","finish_reason":"length"}]}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(tc.resp))
			}))
			defer srv.Close()
			c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
			_, err := c.Complete(context.Background(), correction.Prompt{
				User: "x", Template: tc.tmpl,
			})
			require.Error(t, err)
			require.Contains(t, err.Error(), "truncated")
		})
	}
}

// finish_reason "stop" (and absent) must NOT error — only "length" is fatal.
func TestCompleteAcceptsStopFinishReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}`))
	}))
	defer srv.Close()
	c := New(Config{BaseURL: srv.URL + "/v1", Model: "m"})
	out, err := c.Complete(context.Background(), correction.Prompt{
		User: "x", Template: correction.TemplateChatInstruct,
	})
	require.NoError(t, err)
	require.Equal(t, "ok", out)
}

// The budget must scale with input length so a long-but-legitimate correction
// is not truncated by a tiny fixed cap (the old 512 cap truncated ~>200-word
// inputs). The floor and a generous ceiling still bound runaway generation.
func TestCompletionBudgetScalesAndCaps(t *testing.T) {
	require.Equal(t, 64, completionBudget("one two"))
	long := strings.Repeat("word ", 1000) // 1000 words -> 2500 raw
	require.Equal(t, 2048, completionBudget(long))
}

func TestCompleteSendsSeedOnBothPaths(t *testing.T) {
	for _, tc := range []struct {
		name string
		tmpl correction.PromptTemplate
		resp string
	}{
		{"chat", correction.TemplateChatInstruct, `{"choices":[{"message":{"content":"ok"}}]}`},
		{"completions", correction.TemplateGRMRNative, `{"choices":[{"text":"ok"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotBody map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				_, _ = w.Write([]byte(tc.resp))
			}))
			defer srv.Close()
			c := New(Config{BaseURL: srv.URL + "/v1", Model: "m", Seed: 42})
			_, err := c.Complete(context.Background(), correction.Prompt{
				System: "sys", User: "txt", Template: tc.tmpl,
			})
			require.NoError(t, err)
			seed, ok := gotBody["seed"]
			require.True(t, ok, "payload must carry seed")
			require.EqualValues(t, 42, seed)
		})
	}
}
