// Package llm is the Anthropic-compatible slow-path adapter. It implements
// correction.LLMClient against POST {base}/v1/messages (the Anthropic Messages
// API). Pure transport, text in/out — no streaming, no tools. Used for the
// rephrase override when the user selects the "anthropic" provider.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/grammarforge/bridge/internal/correction"
)

const anthropicVersion = "2023-06-01"

// AnthropicClient talks to an Anthropic-compatible Messages API.
type AnthropicClient struct {
	cfg  Config
	http *http.Client
}

// NewAnthropic constructs an Anthropic client with a sane timeout.
func NewAnthropic(cfg Config) *AnthropicClient {
	return &AnthropicClient{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

// Complete renders p to /v1/messages and returns the model's text. System maps
// to the top-level `system` field; User maps to a single user message.
func (c *AnthropicClient) Complete(ctx context.Context, p correction.Prompt) (string, error) {
	payload := map[string]any{
		"model":      c.cfg.Model,
		"max_tokens": completionBudget(p.User),
		"messages":   []map[string]string{{"role": "user", "content": p.User}},
	}
	if p.System != "" {
		payload["system"] = p.System
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", anthropicVersion)
	if c.cfg.APIKey != "" {
		req.Header.Set("x-api-key", c.cfg.APIKey)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("anthropic request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("anthropic backend status %d", resp.StatusCode)
	}
	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decode anthropic response: %w", err)
	}
	for _, b := range parsed.Content {
		if b.Type == "text" && b.Text != "" {
			return strings.TrimSpace(b.Text), nil
		}
	}
	if len(parsed.Content) > 0 {
		return strings.TrimSpace(parsed.Content[0].Text), nil
	}
	return "", fmt.Errorf("anthropic returned no content")
}
