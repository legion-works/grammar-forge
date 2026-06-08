// harper.h - Header file for the Rust library

#ifndef HARPER_H // Include guard to prevent multiple inclusions
#define HARPER_H

#include <stdint.h>

#ifdef __cplusplus // Check if we're compiling with a C++ compiler
extern "C" { // If so, use C linkage for the following functions
#endif

// Opaque types
typedef struct Document Document;
typedef struct Lint Lint;
typedef struct LintGroup LintGroup;

// Get the version of the Harper Core library
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_version(void);

// Create a new document from plain English text
// Returns NULL on error
Document* harper_create_document(const char* text);

// Create a new document by parsing the text as Markdown. Code spans, fenced code
// blocks, math, and HTML are masked as unlintable so Harper does not flag inside
// them. If ignore_link_title is non-zero, Markdown link titles are also ignored.
// Free with harper_free_document, the same as harper_create_document.
// Returns NULL on error
Document* harper_create_document_markdown(const char* text, int32_t ignore_link_title);

// Free a document created by harper_create_document[_markdown]
void harper_free_document(Document* doc);

// Get the full text content of the document
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_document_text(const Document* doc);

// Get the number of tokens in the document
// Returns -1 on error
int32_t harper_get_token_count(const Document* doc);

// Get the text of a specific token in the document
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_token_text(const Document* doc, int32_t index);

// Dialect codes for harper_create_lint_group_with_dialect. These are defined by
// THIS library (not harper-core's internal bit-flag discriminants) so the C ABI
// stays stable regardless of harper-core internals. Unknown codes fall back to
// American.
#define HARPER_DIALECT_AMERICAN   0
#define HARPER_DIALECT_BRITISH    1
#define HARPER_DIALECT_CANADIAN   2
#define HARPER_DIALECT_AUSTRALIAN 3
#define HARPER_DIALECT_INDIAN     4

// Create a new lint group with curated rules for the given dialect code (see the
// HARPER_DIALECT_* constants above; unknown -> American).
// Returns NULL on error
LintGroup* harper_create_lint_group_with_dialect(int32_t dialect);

// Create a new lint group with curated rules (American dialect; back-compat
// wrapper over harper_create_lint_group_with_dialect(HARPER_DIALECT_AMERICAN)).
// Returns NULL on error
LintGroup* harper_create_lint_group(void);

// Free a lint group created by harper_create_lint_group[_with_dialect]
void harper_free_lint_group(LintGroup* lint_group);

// Get all lints for a document using a lint group
// Returns an array of Lint pointers, and sets count to the number of lints
// The caller is responsible for freeing both the array and each Lint using harper_free_lints
// Returns NULL on error
Lint** harper_get_lints(const Document* doc, LintGroup* lint_group, int32_t* count);

// Free an array of lints created by harper_get_lints
void harper_free_lints(Lint** lints, int32_t count);

// Get the message for a lint
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_lint_message(const Lint* lint);

// Get the kind/category of a lint as a stable string key, e.g. "Spelling",
// "Capitalization", "Enhancement", "WordChoice", "Style", "Agreement",
// "Punctuation", "Repetition". This is harper-core's
// LintKind::to_string_key(), stable for the pinned harper-core version, so it
// is safe to match on (far more robust than parsing the human-readable message).
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_lint_kind(const Lint* lint);

// Get the range of a lint in the document (character offsets, not byte offsets)
// Sets start and end to -1 on error
void harper_get_lint_range(const Lint* lint, int32_t* start, int32_t* end);

// Get the number of suggestions for a lint
// Returns -1 on error
int32_t harper_get_suggestion_count(const Lint* lint);

// Get the text of a specific suggestion for a lint
// Returns a newly allocated string that must be freed by the caller using free()
// Returns NULL on error
char* harper_get_suggestion_text(const Lint* lint, int32_t index);

// Suggestion kind codes written to *out_kind by harper_get_suggestion. These
// mirror harper-core's Suggestion enum.
#define HARPER_SUGGESTION_REPLACE_WITH 0
#define HARPER_SUGGESTION_INSERT_AFTER 1
#define HARPER_SUGGESTION_REMOVE       2

// Gets a structured suggestion for a lint (replaces parsing the human-readable
// harper_get_suggestion_text output). Writes the kind code (see
// HARPER_SUGGESTION_* above) to *out_kind, and for REPLACE_WITH / INSERT_AFTER a
// newly allocated payload string to *out_text (the caller must free it with
// free()); for REMOVE, *out_text is set to NULL. INSERT_AFTER's payload is to be
// inserted after the lint's range.
// Returns 0 on success, or -1 on error (NULL argument, index out of range, or
// allocation failure).
int32_t harper_get_suggestion(const Lint* lint, int32_t index, int32_t* out_kind, char** out_text);

#ifdef __cplusplus
} // End of extern "C"
#endif

#endif // End of include guard
