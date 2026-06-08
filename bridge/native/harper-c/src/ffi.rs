// ffi.rs - Foreign Function Interface for Rust to C

// Importing the necessary types from the standard library
use std::ffi::{CStr, CString}; // For handling C-compatible strings
use std::os::raw::{c_char, c_int}; // This allows us to use C-compatible types
use std::ptr;
use std::sync::Arc;

// Import some basic things from Harper
use harper_core::{
    core_version,
    linting::{Lint, LintGroup, Linter, Suggestion},
    parsers::MarkdownOptions,
    spell::FstDictionary,
    Document,
};

/// Gets the version of the Harper Core library as a string.
/// Returns a newly allocated string that must be freed by the caller using free().
#[no_mangle]
pub extern "C" fn harper_get_version() -> *mut c_char {
    match CString::new(core_version()) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Creates a new document from plain English text.
/// Returns a pointer to the document, or null if there was an error.
/// The caller is responsible for freeing the document using harper_free_document.
#[no_mangle]
pub extern "C" fn harper_create_document(text: *const c_char) -> *mut Document {
    if text.is_null() {
        return ptr::null_mut();
    }

    // Convert C string to Rust string
    let c_str = unsafe { CStr::from_ptr(text) };
    let text_str = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    // Create the document
    let doc = Document::new_plain_english_curated(text_str);

    // Box the document and leak it to get a raw pointer
    Box::into_raw(Box::new(doc))
}

/// Creates a new document by parsing the text as Markdown. Code spans, fenced
/// code blocks, math, and HTML are masked as unlintable so Harper does not flag
/// inside them (reinforcing the "don't lint code" invariant at the engine).
/// If ignore_link_title is non-zero, Markdown link titles are also ignored.
/// Returns a pointer to the document, or null on error. The caller frees it with
/// harper_free_document, exactly like harper_create_document.
#[no_mangle]
pub extern "C" fn harper_create_document_markdown(
    text: *const c_char,
    ignore_link_title: c_int,
) -> *mut Document {
    if text.is_null() {
        return ptr::null_mut();
    }

    let c_str = unsafe { CStr::from_ptr(text) };
    let text_str = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return ptr::null_mut(),
    };

    // MarkdownOptions is #[non_exhaustive], so it cannot be struct-literal'd from
    // outside harper-core; start from the default and set the one field.
    let mut options = MarkdownOptions::default();
    options.ignore_link_title = ignore_link_title != 0;

    let doc = Document::new_markdown_curated(text_str, options);
    Box::into_raw(Box::new(doc))
}

/// Frees a document created by harper_create_document.
#[no_mangle]
pub extern "C" fn harper_free_document(doc: *mut Document) {
    if !doc.is_null() {
        unsafe {
            // Convert the raw pointer back to a Box and let it drop
            let _ = Box::from_raw(doc);
        }
    }
}

/// Gets the full text content of the document.
/// Returns a newly allocated C string that must be freed by the caller using free().
/// Returns NULL if the document is NULL or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_document_text(doc: *const Document) -> *mut c_char {
    if doc.is_null() {
        return ptr::null_mut();
    }

    let doc = unsafe { &*doc };
    let text = doc.get_full_string();

    match CString::new(text) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Gets the number of tokens in the document.
/// Returns -1 if the document is NULL.
#[no_mangle]
pub extern "C" fn harper_get_token_count(doc: *const Document) -> c_int {
    if doc.is_null() {
        return -1;
    }

    let doc = unsafe { &*doc };
    doc.get_tokens().len() as c_int
}

/// Gets the text of a specific token in the document.
/// Returns a newly allocated C string that must be freed by the caller using free().
/// Returns NULL if the document is NULL, the index is out of bounds, or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_token_text(doc: *const Document, index: c_int) -> *mut c_char {
    if doc.is_null() || index < 0 {
        return ptr::null_mut();
    }

    let doc = unsafe { &*doc };
    let tokens = doc.get_tokens();

    if index as usize >= tokens.len() {
        return ptr::null_mut();
    }

    let token = &tokens[index as usize];
    let text = doc.get_span_content_str(&token.span);

    match CString::new(text) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Maps a stable FFI dialect code to harper-core's Dialect. The codes are
/// defined by THIS crate (NOT harper-core's bit-flag discriminants, which are
/// 1/2/4/8/16) so the C ABI stays stable regardless of harper-core internals:
/// 0=American, 1=British, 2=Canadian, 3=Australian, 4=Indian. Unknown -> American.
fn dialect_from_code(code: c_int) -> harper_core::Dialect {
    match code {
        1 => harper_core::Dialect::British,
        2 => harper_core::Dialect::Canadian,
        3 => harper_core::Dialect::Australian,
        4 => harper_core::Dialect::Indian,
        _ => harper_core::Dialect::American,
    }
}

/// Creates a new lint group with curated rules for the given dialect code
/// (0=American, 1=British, 2=Canadian, 3=Australian, 4=Indian; unknown ->
/// American). Returns a pointer to the lint group, or null on error. The caller
/// must free it with harper_free_lint_group.
#[no_mangle]
pub extern "C" fn harper_create_lint_group_with_dialect(dialect: c_int) -> *mut LintGroup {
    let dictionary = FstDictionary::curated();
    let lint_group = LintGroup::new_curated(Arc::new(dictionary), dialect_from_code(dialect));
    Box::into_raw(Box::new(lint_group))
}

/// Creates a new lint group with curated rules (American dialect — back-compat
/// wrapper over harper_create_lint_group_with_dialect(0)).
/// Returns a pointer to the lint group, or null if there was an error.
/// The caller is responsible for freeing the lint group using harper_free_lint_group.
#[no_mangle]
pub extern "C" fn harper_create_lint_group() -> *mut LintGroup {
    harper_create_lint_group_with_dialect(0)
}

/// Enable or disable a single curated rule by its key (the linter struct name,
/// e.g. "SpellCheck", "LongSentences", "RepeatedWords", "AnA"). enabled != 0
/// enables. Returns 0 on success, -1 on error (NULL group/key or invalid UTF-8).
/// Unknown keys are accepted (harper-core stores the override in FlatConfig; it
/// simply never matches a registered rule).
#[no_mangle]
pub extern "C" fn harper_lint_group_set_rule_enabled(
    lint_group: *mut LintGroup,
    key: *const c_char,
    enabled: c_int,
) -> c_int {
    if lint_group.is_null() || key.is_null() {
        return -1;
    }
    let key_str = match unsafe { CStr::from_ptr(key) }.to_str() {
        Ok(s) => s,
        Err(_) => return -1,
    };
    let group = unsafe { &mut *lint_group };
    group.config.set_rule_enabled(key_str, enabled != 0);
    0
}

/// Frees a lint group created by harper_create_lint_group.
#[no_mangle]
pub extern "C" fn harper_free_lint_group(lint_group: *mut LintGroup) {
    if !lint_group.is_null() {
        unsafe {
            let _ = Box::from_raw(lint_group);
        }
    }
}

/// Gets all lints for a document using a lint group.
/// Returns a pointer to an array of Lint pointers, and sets count to the number of lints.
/// The caller is responsible for freeing both the array and each Lint using harper_free_lints.
/// Returns NULL if any pointer is NULL or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_lints(
    doc: *const Document,
    lint_group: *mut LintGroup,
    count: *mut c_int,
) -> *mut *mut Lint {
    if doc.is_null() || lint_group.is_null() || count.is_null() {
        return ptr::null_mut();
    }

    let doc = unsafe { &*doc };
    let lint_group = unsafe { &mut *lint_group };

    let lints = lint_group.lint(doc);

    // Convert Vec<Lint> to Vec<Box<Lint>>
    let boxed_lints: Vec<Box<Lint>> = lints.into_iter().map(Box::new).collect();

    // Convert to raw pointers
    let mut raw_lints: Vec<*mut Lint> = boxed_lints.into_iter().map(Box::into_raw).collect();

    // Set the count
    unsafe {
        *count = raw_lints.len() as c_int;
    }

    // Return the array
    let result = raw_lints.as_mut_ptr();
    std::mem::forget(raw_lints); // Prevent deallocation
    result
}

/// Frees an array of lints created by harper_get_lints.
#[no_mangle]
pub extern "C" fn harper_free_lints(lints: *mut *mut Lint, count: c_int) {
    if lints.is_null() || count <= 0 {
        return;
    }

    unsafe {
        // Convert back to Vec
        let lints_vec = Vec::from_raw_parts(lints, count as usize, count as usize);

        // Free each lint
        for lint in lints_vec {
            if !lint.is_null() {
                let _ = Box::from_raw(lint);
            }
        }
    }
}

/// Gets the message for a lint.
/// Returns a newly allocated string that must be freed by the caller using free().
/// Returns NULL if the lint is NULL or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_lint_message(lint: *const Lint) -> *mut c_char {
    if lint.is_null() {
        return ptr::null_mut();
    }

    let lint = unsafe { &*lint };
    let message = lint.message.to_string();

    match CString::new(message) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Gets the kind/category of a lint as a stable string key, e.g. "Spelling",
/// "Capitalization", "Enhancement", "WordChoice", "Style", "Agreement",
/// "Punctuation", "Repetition". This is harper_core::linting::LintKind's
/// to_string_key(), which is stable for the pinned harper-core version (it is
/// the inverse of from_string_key and is used by Harper for config maps), so it
/// is safe to match on from C/Go — far more robust than parsing the message.
/// Returns a newly allocated string that must be freed by the caller using
/// free(). Returns NULL if the lint is NULL or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_lint_kind(lint: *const Lint) -> *mut c_char {
    if lint.is_null() {
        return ptr::null_mut();
    }

    let lint = unsafe { &*lint };

    match CString::new(lint.lint_kind.to_string_key()) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Gets the range of a lint in the document.
/// Sets start and end to -1 if the lint is NULL.
#[no_mangle]
pub extern "C" fn harper_get_lint_range(lint: *const Lint, start: *mut c_int, end: *mut c_int) {
    if lint.is_null() {
        unsafe {
            *start = -1;
            *end = -1;
        }
        return;
    }

    let lint = unsafe { &*lint };
    unsafe {
        *start = lint.span.start as c_int;
        *end = lint.span.end as c_int;
    }
}

/// Gets the number of suggestions for a lint.
/// Returns -1 if the lint is NULL.
#[no_mangle]
pub extern "C" fn harper_get_suggestion_count(lint: *const Lint) -> c_int {
    if lint.is_null() {
        return -1;
    }

    let lint = unsafe { &*lint };
    lint.suggestions.len() as c_int
}

/// Gets the text of a specific suggestion for a lint.
/// Returns a newly allocated string that must be freed by the caller using free().
/// Returns NULL if the lint is NULL, the index is out of bounds, or if memory allocation fails.
#[no_mangle]
pub extern "C" fn harper_get_suggestion_text(lint: *const Lint, index: c_int) -> *mut c_char {
    if lint.is_null() || index < 0 {
        return ptr::null_mut();
    }

    let lint = unsafe { &*lint };

    if index as usize >= lint.suggestions.len() {
        return ptr::null_mut();
    }

    let suggestion = &lint.suggestions[index as usize];

    // Convert the suggestion to a readable string
    let suggestion_text = match suggestion {
        harper_core::linting::Suggestion::ReplaceWith(chars) => {
            format!("Replace with: \"{}\"", chars.iter().collect::<String>())
        }
        harper_core::linting::Suggestion::InsertAfter(chars) => {
            format!("Insert \"{}\"", chars.iter().collect::<String>())
        }
        harper_core::linting::Suggestion::Remove => "Remove error".to_string(),
    };

    match CString::new(suggestion_text) {
        Ok(cstr) => cstr.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Gets a structured suggestion for a lint, replacing the need to parse the
/// human-readable harper_get_suggestion_text output. Writes the suggestion kind
/// code to *out_kind (0 = ReplaceWith, 1 = InsertAfter, 2 = Remove) and, for
/// ReplaceWith/InsertAfter, a newly allocated payload string (the replacement or
/// the text to insert after the lint range) to *out_text, which the caller must
/// free with free(); for Remove, *out_text is set to NULL. Returns 0 on success,
/// or -1 on error (NULL argument, index out of range, or allocation failure).
#[no_mangle]
pub extern "C" fn harper_get_suggestion(
    lint: *const Lint,
    index: c_int,
    out_kind: *mut c_int,
    out_text: *mut *mut c_char,
) -> c_int {
    if lint.is_null() || out_kind.is_null() || out_text.is_null() || index < 0 {
        return -1;
    }

    let lint = unsafe { &*lint };
    if index as usize >= lint.suggestions.len() {
        return -1;
    }

    let (kind, text): (c_int, Option<String>) = match &lint.suggestions[index as usize] {
        Suggestion::ReplaceWith(chars) => (0, Some(chars.iter().collect())),
        Suggestion::InsertAfter(chars) => (1, Some(chars.iter().collect())),
        Suggestion::Remove => (2, None),
    };

    let text_ptr = match text {
        Some(s) => match CString::new(s) {
            Ok(cstr) => cstr.into_raw(),
            Err(_) => return -1,
        },
        None => ptr::null_mut(),
    };

    unsafe {
        *out_kind = kind;
        *out_text = text_ptr;
    }
    0
}
