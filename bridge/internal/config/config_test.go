package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	if c.RESTAddr != ":8000" {
		t.Errorf("RESTAddr = %q, want :8000", c.RESTAddr)
	}
	if c.LLMBaseURL != "http://vllm:8000/v1" {
		t.Errorf("LLMBaseURL = %q, want default", c.LLMBaseURL)
	}
	if c.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", c.LogLevel)
	}
}

func TestLoadOverrides(t *testing.T) {
	env := map[string]string{
		"GF_REST_ADDR":    ":9000",
		"GF_LLM_BASE_URL": "http://ollama:11434/v1",
	}
	c := Load(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if c.RESTAddr != ":9000" {
		t.Errorf("RESTAddr = %q, want :9000", c.RESTAddr)
	}
	if c.LLMBaseURL != "http://ollama:11434/v1" {
		t.Errorf("LLMBaseURL = %q", c.LLMBaseURL)
	}
}

func TestLoadLLMFormatDefault(t *testing.T) {
	c := Load(func(string) (string, bool) { return "", false })
	if c.LLMFormat != "grmr_native" {
		t.Errorf("LLMFormat = %q, want grmr_native", c.LLMFormat)
	}
}
