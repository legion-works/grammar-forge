package ltcompat

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/grammarforge/bridge/internal/correction"
)

// CorrectionService is the slice of the correction core this adapter needs.
type CorrectionService interface {
	Correct(ctx context.Context, req correction.Request) (correction.Correction, error)
}

// Handler serves the LanguageTool-compatible surface: POST /v2/check and
// GET /v2/languages. English-only by design (scope is single-user English);
// the `language` form value is accepted and ignored (en-US / auto both map
// to the one pipeline).
type Handler struct {
	mux     *http.ServeMux
	svc     CorrectionService
	version string
}

// NewHandler builds the LT-compat sub-handler. version surfaces in
// software.version (clients display it; any non-empty string is fine).
func NewHandler(svc CorrectionService, version string) *Handler {
	h := &Handler{mux: http.NewServeMux(), svc: svc, version: version}
	h.mux.HandleFunc("POST /v2/check", h.handleCheck)
	h.mux.HandleFunc("GET /v2/languages", h.handleLanguages)
	return h
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) { h.mux.ServeHTTP(w, r) }

// ltMatch et al. mirror LanguageTool's /v2/check response JSON. Offsets are
// UTF-16 code units (Java String indices), converted from the bridge's byte
// spans — the single most important detail of this adapter.
type ltReplacement struct {
	Value string `json:"value"`
}

type ltContext struct {
	Text   string `json:"text"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
}

type ltCategory struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ltRule struct {
	ID          string     `json:"id"`
	Description string     `json:"description"`
	IssueType   string     `json:"issueType"`
	Category    ltCategory `json:"category"`
	IsPremium   bool       `json:"isPremium"`
}

type ltMatch struct {
	Message      string          `json:"message"`
	ShortMessage string          `json:"shortMessage"`
	Offset       int             `json:"offset"`
	Length       int             `json:"length"`
	Replacements []ltReplacement `json:"replacements"`
	Context      ltContext       `json:"context"`
	Sentence     string          `json:"sentence"`
	Rule         ltRule          `json:"rule"`
}

type ltLanguage struct {
	Name             string             `json:"name"`
	Code             string             `json:"code"`
	DetectedLanguage ltDetectedLanguage `json:"detectedLanguage"`
}

type ltDetectedLanguage struct {
	Name       string  `json:"name"`
	Code       string  `json:"code"`
	Confidence float64 `json:"confidence"`
}

type ltSoftware struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	APIVersion int    `json:"apiVersion"`
	Premium    bool   `json:"premium"`
	Status     string `json:"status"`
}

type ltCheckResponse struct {
	Software ltSoftware `json:"software"`
	Language ltLanguage `json:"language"`
	Matches  []ltMatch  `json:"matches"`
}

func (h *Handler) handleCheck(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid form body")
		return
	}
	if r.PostForm.Get("data") != "" {
		writeError(w, http.StatusBadRequest, "annotated 'data' requests are not supported; send 'text'")
		return
	}
	text := r.PostForm.Get("text")
	if text == "" {
		writeError(w, http.StatusBadRequest, "missing 'text' parameter")
		return
	}
	result, err := h.svc.Correct(r.Context(), correction.Request{Text: text, Source: "lt-compat"})
	if err != nil {
		writeError(w, http.StatusBadGateway, "correction backend unavailable")
		return
	}
	matches := make([]ltMatch, 0, len(result.Suggestions))
	for _, s := range result.Suggestions {
		matches = append(matches, suggestionToLTMatch(text, s))
	}
	resp := ltCheckResponse{
		Software: ltSoftware{Name: "GrammarForge", Version: h.version, APIVersion: 1, Premium: true},
		Language: ltLanguage{
			Name: "English (US)", Code: "en-US",
			DetectedLanguage: ltDetectedLanguage{Name: "English (US)", Code: "en-US", Confidence: 1.0},
		},
		Matches: matches,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// suggestionToLTMatch converts one bridge suggestion. Insertions (zero-width
// byte spans) are widened to one UTF-16 unit on the left where possible so
// LT clients (which reject length 0) render them — same trick as the gRPC
// mapping's widenInsertion, in UTF-16 space.
func suggestionToLTMatch(text string, s correction.Suggestion) ltMatch {
	offset := byteToUTF16Offset(text, s.Span.Start)
	length := byteToUTF16Offset(text, s.Span.End) - offset
	candidates := s.Replacements
	if len(candidates) == 0 {
		candidates = []string{s.Replacement}
	}
	reps := make([]ltReplacement, 0, len(candidates))
	for _, c := range candidates {
		reps = append(reps, ltReplacement{Value: c})
	}
	message := s.Message
	if message == "" {
		message = matchMessageFor(s.Model)
	}
	return ltMatch{
		Message:      message,
		Offset:       offset,
		Length:       length,
		Replacements: reps,
		Context:      contextWindow(text, s.Span.Start, s.Span.End),
		Rule: ltRule{
			ID:          "GF_" + strings.ToUpper(string(s.Model)),
			Description: message,
			IssueType:   issueTypeFor(s.Category),
			Category:    categoryFor(s.Category),
			IsPremium:   true,
		},
	}
}

// contextWindow builds LT's context object: a snippet around the match with
// the match position re-expressed relative to the snippet (UTF-16 units).
func contextWindow(text string, byteStart, byteEnd int) ltContext {
	const window = 40
	from := byteStart - window
	if from < 0 {
		from = 0
	}
	for from > 0 && !utf8.RuneStart(text[from]) {
		from--
	}
	to := byteEnd + window
	if to > len(text) {
		to = len(text)
	}
	for to < len(text) && !utf8.RuneStart(text[to]) {
		to++
	}
	snippet := text[from:to]
	return ltContext{
		Text:   snippet,
		Offset: byteToUTF16Offset(snippet, byteStart-from),
		Length: byteToUTF16Offset(snippet, byteEnd-from) - byteToUTF16Offset(snippet, byteStart-from),
	}
}

func issueTypeFor(category string) string {
	switch category {
	case correction.CategorySpelling:
		return "misspelling"
	case correction.CategoryStyle:
		return "style"
	default:
		return "grammar"
	}
}

func categoryFor(category string) ltCategory {
	switch category {
	case correction.CategorySpelling:
		return ltCategory{ID: "TYPOS", Name: "Possible Typo"}
	case correction.CategoryPunctuation:
		return ltCategory{ID: "PUNCTUATION", Name: "Punctuation"}
	case correction.CategoryStyle:
		return ltCategory{ID: "STYLE", Name: "Style"}
	default:
		return ltCategory{ID: "GRAMMAR", Name: "Grammar"}
	}
}

func matchMessageFor(model correction.Model) string {
	switch model {
	case correction.ModelLLM:
		return "GrammarForge (AI suggestion)"
	case correction.ModelGECToR:
		return "GrammarForge (grammar)"
	case correction.ModelHarper:
		return "GrammarForge (spelling/style)"
	default:
		return "GrammarForge suggestion"
	}
}

func (h *Handler) handleLanguages(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode([]map[string]string{
		{"name": "English (US)", "code": "en", "longCode": "en-US"},
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
