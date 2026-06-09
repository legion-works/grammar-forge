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

func TestAnthropicComplete(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1/messages", r.URL.Path)
		require.Equal(t, "test-key", r.Header.Get("x-api-key"))
		require.NotEmpty(t, r.Header.Get("anthropic-version"))
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		require.NoError(t, json.Unmarshal(b, &body))
		require.Equal(t, "claude-x", body["model"])
		msgs := body["messages"].([]any)
		first := msgs[0].(map[string]any)
		require.Equal(t, "rewrite this", first["content"])
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"rewritten"}]}`))
	}))
	defer srv.Close()
	c := NewAnthropic(Config{BaseURL: srv.URL, Model: "claude-x", APIKey: "test-key"})
	out, err := c.Complete(context.Background(), correction.Prompt{
		User: "rewrite this", Template: correction.TemplateChatInstruct,
	})
	require.NoError(t, err)
	require.Equal(t, "rewritten", strings.TrimSpace(out))
}

func TestAnthropicCompleteIncludesSystem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		require.Equal(t, "be formal", body["system"])
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}]}`))
	}))
	defer srv.Close()
	c := NewAnthropic(Config{BaseURL: srv.URL, Model: "claude-x", APIKey: "k"})
	_, err := c.Complete(context.Background(), correction.Prompt{
		System: "be formal", User: "x", Template: correction.TemplateChatInstruct,
	})
	require.NoError(t, err)
}
