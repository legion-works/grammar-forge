package correction

// DiffToSuggestions is exported so the gector package can reuse the byte-diff
// used by the LLM path. Both paths emit the same Suggestion shape (Model is
// overwritten by the caller).
func DiffToSuggestions(original, corrected string) []Suggestion {
	return diffToSuggestions(original, corrected)
}
