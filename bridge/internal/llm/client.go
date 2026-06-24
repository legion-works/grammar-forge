// Package llm is the OpenAI-compatible slow-path client. It implements
// correction.LLMClient and is pure transport — it renders a prebuilt Prompt to
// /v1/completions (GRMR-native) or /v1/chat/completions (chat) and returns text.
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

// Config configures the client. APIKey is optional and never logged.
type Config struct {
	BaseURL string // e.g. http://llamacpp:8000/v1
	Model   string
	APIKey  string
	Seed    int // sampling seed for reproducible output (sent on every request)
}

// Client talks to an OpenAI-compatible server.
type Client struct {
	cfg  Config
	http *http.Client
}

// New constructs a Client with a sane timeout.
func New(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 30 * time.Second}}
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Complete renders p to the correct endpoint and returns the model's text.
func (c *Client) Complete(ctx context.Context, p correction.Prompt) (string, error) {
	maxTokens := completionBudget(p.User)
	var endpoint string
	var payload any
	if p.Template == correction.TemplateChatInstruct {
		endpoint = "/chat/completions"
		msgs := make([]chatMessage, 0, 2)
		if p.System != "" {
			msgs = append(msgs, chatMessage{Role: "system", Content: p.System})
		}
		msgs = append(msgs, chatMessage{Role: "user", Content: p.User})
		payload = map[string]any{
			"model": c.cfg.Model, "messages": msgs,
			// p.Temperature is 0 for correction/rephrase/tone (greedy, golden-eval
			// stable) and non-zero only for completion (varied continuations).
			"temperature": p.Temperature, "seed": c.cfg.Seed, "max_tokens": maxTokens,
			// Reasoning-capable instruct models (Gemma-4, Qwen3-thinking) otherwise
			// emit chain-of-thought that consumes the token budget and leaves
			// message.content empty for a single-shot grammar correction. This
			// field disables thinking; backends/models without it ignore it.
			"chat_template_kwargs": map[string]any{"enable_thinking": false},
			// llama.cpp KV prefix reuse: the system prompt (large, stable,
			// shared by every sentence-level request) is cached server-side
			// so TTFT drops to ~the user-sentence tokens. Non-llama.cpp
			// OpenAI-compatible backends ignore unknown fields.
			"cache_prompt": true,
		}
	} else {
		endpoint = "/completions"
		payload = map[string]any{
			"model": c.cfg.Model, "prompt": p.User,
			"temperature": p.Temperature, "seed": c.cfg.Seed, "max_tokens": maxTokens, "stop": p.Stop,
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("marshal request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("llm request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("llm backend status %d", resp.StatusCode)
	}

	var parsed struct {
		Choices []struct {
			Text         string `json:"text"`
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("decode llm response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return "", fmt.Errorf("llm returned no choices")
	}
	ch := parsed.Choices[0]
	// finish_reason "length" means the backend hit max_tokens and the output
	// is TRUNCATED mid-text. Returning the partial text is a data-loss hazard:
	// the correction diff converts the missing tail into mass-deletion
	// suggestions (verified live 2026-06-10: a 6.5KB input produced a
	// 3,591-byte deletion). Surface it as an error so callers fall back / fail.
	if ch.FinishReason == "length" {
		return "", fmt.Errorf("llm output truncated at max_tokens (finish_reason=length)")
	}
	if ch.Text != "" {
		return strings.TrimSpace(ch.Text), nil
	}
	return strings.TrimSpace(ch.Message.Content), nil
}

// completionBudget sizes max_tokens to the input: ~2.5 tokens/word, clamped.
// Correction output is roughly input-sized, so the ceiling must scale with
// realistic inputs: the old 512 cap truncated ~>200-word inputs (the
// truncation then became mass-deletion suggestions downstream). 2048 still
// bounds runaway generation; max_tokens is a cap, not a charge — greedy
// correction stops at the corrected text's natural end.
func completionBudget(user string) int {
	words := len(strings.Fields(user))
	n := int(float64(words) * 2.5)
	if n < 64 {
		n = 64
	}
	if n > 2048 {
		n = 2048
	}
	return n
}
