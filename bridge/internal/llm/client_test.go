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
