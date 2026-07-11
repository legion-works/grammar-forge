// Package llm is the OpenAI-compatible slow-path client. It implements
// correction.LLMClient and is pure transport — it renders a prebuilt Prompt to
// /v1/completions (GRMR-native) or /v1/chat/completions (chat) and returns text.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
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
	// NBestWire selects the Task 8 N-best transport strategy for CompleteN:
	// "sequential" (default/zero value — N separate requests using seeds
	// Seed, Seed+1, ..., portable to any OpenAI-compatible BYO backend) or
	// "n_param" (ONE request with "n": N — only honored by backends that
	// implement OpenAI's n parameter; verified live against llama.cpp build
	// b9828-ebd048fc5). Set from config.Config.LLMNBestWire in main, mirroring
	// the Seed copy pattern. Never affects Complete (the legacy single-
	// candidate path never sends "n").
	NBestWire string
}

// Client talks to an OpenAI-compatible server.
type Client struct {
	cfg     Config
	http    *http.Client
	retry   RetryConfig
	breaker *circuitBreaker
}

// New constructs a Client with a sane timeout and conservative resilience
// defaults (retry on, 1 retry; breaker on, 5-consecutive-failure threshold —
// see DefaultRetryConfig/DefaultBreakerConfig). Override via SetRetryConfig /
// SetBreakerConfig (main.go wires these from config.Config's GF_LLM_RETRY_*
// / GF_LLM_BREAKER_* knobs).
func New(cfg Config) *Client {
	return &Client{
		cfg:     cfg,
		http:    &http.Client{Timeout: 30 * time.Second},
		retry:   DefaultRetryConfig(),
		breaker: newCircuitBreaker(DefaultBreakerConfig()),
	}
}

// SetRetryConfig overrides the retry policy. Optional; New already applies
// DefaultRetryConfig().
func (c *Client) SetRetryConfig(cfg RetryConfig) { c.retry = cfg }

// SetBreakerConfig overrides the circuit-breaker policy. Optional; New
// already applies a breaker with DefaultBreakerConfig(). Replaces the
// breaker instance, so any in-flight failure count from the old policy is
// discarded (breaker changes are an operator config action, not a
// per-request toggle).
func (c *Client) SetBreakerConfig(cfg BreakerConfig) { c.breaker = newCircuitBreaker(cfg) }

// BreakerState exposes the breaker's state string ("closed"|"open"|
// "half_open") for the /stats cache_metrics surface (see
// correction.CacheMetrics / correction.breakerStater).
func (c *Client) BreakerState() string { return c.breaker.State() }

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// llmChoice is the dual-shape choice element every OpenAI-compatible
// response returns: the completions path populates Text, the chat path
// populates Message.Content. Shared by Complete and CompleteN so both parse
// choices identically.
type llmChoice struct {
	Text         string `json:"text"`
	FinishReason string `json:"finish_reason"`
	Message      struct {
		Content string `json:"content"`
	} `json:"message"`
}

// requestPayload renders p to its endpoint + JSON-able payload. seed
// overrides c.cfg.Seed (CompleteN's sequential strategy varies it per
// request; Complete and CompleteN's n_param strategy always pass
// c.cfg.Seed). n > 0 adds the OpenAI "n" parameter (n_param strategy only);
// n <= 0 omits the key entirely, so the legacy Complete payload shape never
// changes regardless of NBestWire.
func (c *Client) requestPayload(p correction.Prompt, seed, n int) (string, map[string]any) {
	maxTokens := completionBudget(p.User)
	var endpoint string
	var payload map[string]any
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
			// stable) and non-zero only for completion and Task 8 N-best.
			"temperature": p.Temperature, "seed": seed, "max_tokens": maxTokens,
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
			"temperature": p.Temperature, "seed": seed, "max_tokens": maxTokens, "stop": p.Stop,
		}
	}
	if n > 0 {
		payload["n"] = n
	}
	return endpoint, payload
}

// doRequest marshals payload, executes it via executeWithResilience (breaker
// + bounded retry — see resilience.go), and returns the decoded choices.
// Shared by Complete and both CompleteN strategies.
func (c *Client) doRequest(ctx context.Context, endpoint string, payload map[string]any) ([]llmChoice, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	// newReq is called fresh per attempt since an http.Request body reader
	// is single-use; bytes.NewReader(body) is cheap to recreate from the
	// already-marshaled bytes.
	resp, err := executeWithResilience(ctx, c.http, c.breaker, c.retry, "llm", func() (*http.Request, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("build request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if c.cfg.APIKey != "" {
			req.Header.Set("Authorization", "Bearer "+c.cfg.APIKey)
		}
		return req, nil
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	var parsed struct {
		Choices []llmChoice `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("decode llm response: %w", err)
	}
	if len(parsed.Choices) == 0 {
		return nil, fmt.Errorf("llm returned no choices")
	}
	return parsed.Choices, nil
}

// extractChoiceText mirrors Complete's original dual-shape parsing: the
// completions path reads Text, the chat path reads Message.Content — trying
// Text first works for either shape since exactly one of the two is
// populated per wire format. finish_reason "length" means the backend hit
// max_tokens and the output is TRUNCATED mid-text; returning the partial
// text is a data-loss hazard (the correction diff converts the missing tail
// into mass-deletion suggestions — verified live 2026-06-10: a 6.5KB input
// produced a 3,591-byte deletion), so it is surfaced as an error instead.
func extractChoiceText(ch llmChoice) (string, error) {
	if ch.FinishReason == "length" {
		return "", fmt.Errorf("llm output truncated at max_tokens (finish_reason=length)")
	}
	if ch.Text != "" {
		return strings.TrimSpace(ch.Text), nil
	}
	return strings.TrimSpace(ch.Message.Content), nil
}

// Complete renders p to the correct endpoint and returns the model's text.
// Single-candidate legacy path: byte-identical wire payload regardless of
// GF_LLM_NBEST_WIRE (requestPayload never adds "n" here).
func (c *Client) Complete(ctx context.Context, p correction.Prompt) (string, error) {
	endpoint, payload := c.requestPayload(p, c.cfg.Seed, 0)
	choices, err := c.doRequest(ctx, endpoint, payload)
	if err != nil {
		return "", err
	}
	return extractChoiceText(choices[0])
}

// CompleteN requests up to n candidate completions for p (Task 8,
// GF_LLM_NBEST — implements correction.NBestLLMClient). Strategy selected by
// c.cfg.NBestWire ("" and "sequential" both mean sequential — the portable
// BYO-safe default; only the literal "n_param" selects the single-request
// strategy). Both strategies sample at p.Temperature (the correction package
// sets a non-zero N-best temperature on the Prompt it passes here; the
// legacy Complete path above is never touched by this).
func (c *Client) CompleteN(ctx context.Context, p correction.Prompt, n int) ([]string, error) {
	if c.cfg.NBestWire == "n_param" {
		return c.completeNParam(ctx, p, n)
	}
	return c.completeNSequential(ctx, p, n)
}

// completeNParam issues ONE request carrying "n": n and extracts every
// valid candidate from the returned choices. A choice that is truncated
// (finish_reason=="length") or decodes to empty text is REJECTED — dropped
// from the result, not surfaced as a partial string. Returning fewer valid
// candidates than requested is not an error; the correction package's
// short-subset fallback handles that case. An error is returned only when
// the transport itself fails or EVERY choice is invalid.
func (c *Client) completeNParam(ctx context.Context, p correction.Prompt, n int) ([]string, error) {
	endpoint, payload := c.requestPayload(p, c.cfg.Seed, n)
	choices, err := c.doRequest(ctx, endpoint, payload)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(choices))
	for _, ch := range choices {
		text, err := extractChoiceText(ch)
		if err != nil || text == "" {
			continue
		}
		out = append(out, text)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("llm n_param: no valid candidates in %d returned choices", len(choices))
	}
	return out, nil
}

// completeNSequential issues n separate requests, request i (0-based) using
// seed c.cfg.Seed+i and the same prompt otherwise. A per-request transport
// failure, or a truncated/empty single-choice response, drops that
// candidate (logged at Warn per dropped candidate is too noisy for n
// requests; one summary Warn covers the whole batch when the subset is
// short). Zero successes returns the last observed error; 1..n-1 successes
// logs a Warn and returns the subset — the correction package's
// short-subset fallback is the one that decides whether a shrunken set is
// usable, not this transport layer.
func (c *Client) completeNSequential(ctx context.Context, p correction.Prompt, n int) ([]string, error) {
	out := make([]string, 0, n)
	var lastErr error
	for i := range n {
		endpoint, payload := c.requestPayload(p, c.cfg.Seed+i, 0)
		choices, err := c.doRequest(ctx, endpoint, payload)
		if err != nil {
			lastErr = err
			continue
		}
		text, err := extractChoiceText(choices[0])
		if err != nil {
			lastErr = err
			continue
		}
		if text == "" {
			lastErr = fmt.Errorf("llm sequential candidate %d: empty content", i)
			continue
		}
		out = append(out, text)
	}
	if len(out) == 0 {
		return nil, lastErr
	}
	if len(out) < n {
		slog.Warn("llm CompleteN sequential: fewer candidates than requested",
			"requested", n, "succeeded", len(out), "last_err", lastErr)
	}
	return out, nil
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
