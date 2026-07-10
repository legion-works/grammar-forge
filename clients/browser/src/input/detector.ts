// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Editable-field detection. Covers HTMLTextAreaElement, text-like HTMLInputElement,
// contenteditable, role="textbox", and the Google-specific `g_editable` attribute
// (Docs/Sites/Sheets surface their editors as g_editable instead of contenteditable).
// Rejects readonly/disabled (write-protected), and the
// `data-grammarforge-ignore` opt-out for sites that explicitly don't want us.
//
// Nested-editor rule: a contenteditable element nested inside ANOTHER
// contenteditable is not a host — only the outermost editable ancestor is.
// Without this, the observer would report the inner div as a separate field
// and the overlay would render nested highlights. The browser default
// <div contenteditable>…</div> uses one host; nested CE is a styling choice,
// not a separate field.

/** Attribute selectors that indicate a contenteditable ancestor. */
const CE_ANCESTOR_SELECTOR =
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

const EDITABLE_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
    'text',
    'search',
    'url',
    'tel',
])

// ---- Sensitive-field exclusion (product decision, unconditional) ----
//
// The extension must NEVER activate on a field that plausibly holds a
// password / credential / one-time code / payment number — no underlines, no
// orb, no rephrase button, no checking traffic at all. This is enforced HERE,
// the single choke point every attach path (observer.ts's initial sweep +
// attribute-mutation re-evaluation) runs through, so there is no secondary
// gate to bypass and no settings flag that can re-enable it.
//
// `<input type="password">` is excluded unconditionally by the type check
// below (EDITABLE_TEXT_INPUT_TYPES simply omits it — same mechanism that
// already excluded checkbox/submit/etc). `<input type="email">` is EXCLUDED
// here too (product decision: email addresses are sensitive-adjacent PII and
// often double as a login identifier) even though it's a normal editable text
// type per HTML.
//
// Defense-in-depth: autocomplete hints. A field can be `type="text"` (or
// unset) yet still be a password manager's overlay input, an OTP box, or a
// credit-card field — autocomplete is the standard signal for these. We
// check the element's OWN autocomplete first, then fall back to the
// containing <form>'s autocomplete (a form-level hint like
// autocomplete="off" wrapping per-field hints, or a field that omits its own
// autocomplete but inherits the form's).
const SENSITIVE_AUTOCOMPLETE_EXACT: ReadonlySet<string> = new Set([
    'current-password',
    'new-password',
    'one-time-code',
])

/** True when `token` (already lower-cased) is a sensitive autocomplete hint:
 *  an exact match against the password/OTP set, or any `cc-*` (payment card)
 *  token, e.g. `cc-number`, `cc-exp`, `cc-csc`. */
function isSensitiveAutocompleteToken(token: string): boolean {
    if (SENSITIVE_AUTOCOMPLETE_EXACT.has(token)) return true
    return token.startsWith('cc-')
}

/** autocomplete is a space-separated token list (e.g. "billing cc-number");
 *  per spec any token can carry the semantic hint, so check all of them. */
function hasSensitiveAutocomplete(raw: string | null): boolean {
    if (!raw) return false
    const tokens = raw.toLowerCase().trim().split(/\s+/)
    return tokens.some(isSensitiveAutocompleteToken)
}

/** Is `el` (or its containing <form>) marked with a sensitive autocomplete
 *  hint? Checks the element's own `autocomplete` attribute first, then the
 *  owning form's — a field can omit its own hint and rely on the form's, or
 *  a form can carry the hint for a field that doesn't expose one itself. */
function isSensitiveField(el: HTMLElement): boolean {
    if (hasSensitiveAutocomplete(el.getAttribute('autocomplete'))) return true
    const form = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.form
        : el.closest('form')
    if (form && hasSensitiveAutocomplete(form.getAttribute('autocomplete'))) return true
    return false
}

/**
 * Is the `contenteditable` attribute set to a value that means "editable"?
 * Per HTML: "true" (case-insensitive) and "" (present, no value) are true.
 * "false" (case-insensitive) and "inherit" are NOT. We reject "inherit" too
 * because an inherit-only element is not a host on its own — only its
 * (non-existent) editable ancestor would be, and we'd resolve that via the
 * nested-host check anyway.
 */
function isContentEditableTrue(el: Element): boolean {
    const raw = el.getAttribute('contenteditable')
    if (raw == null) return false
    const v = raw.toLowerCase()
    return v === '' || v === 'true' || v === 'plaintext-only'
}

/**
 * Has an editable contenteditable ancestor? Used to reject a contenteditable
 * element that lives inside another contenteditable — only the outermost host
 * is a field. We don't resolve inheritance across non-editable parents; if
 * you want a child of a <div contenteditable="false"> to be editable, set
 * the inner element to contenteditable="true" explicitly.
 */
function hasEditableAncestor(el: Element): boolean {
    return el.parentElement?.closest(CE_ANCESTOR_SELECTOR) != null
}

/**
 * Is `el` an editable text field we should monitor?
 *
 *   <textarea>                                      yes
 *   <input type="text|search|url|tel">              yes (not readonly, not disabled)
 *   <input type="password|email|checkbox|submit|...">  no
 *   <input> (no type attr → defaults to text)      yes
 *   <input autocomplete="current-password|new-password|one-time-code|cc-*">
 *                                                    no (own OR containing <form>'s autocomplete)
 *   <x contenteditable="true" | "">                yes
 *   <x contenteditable="plaintext-only">            yes
 *   <x contenteditable="false" | "FALSE">          no
 *   <x contenteditable="inherit">                  no (only the host decides)
 *   <x role="textbox">                              yes
 *   <x g_editable="true"> (Google apps)             yes
 *   [data-grammarforge-ignore]                      no (opt-out, wins)
 *   null / non-Element                              no
 *   contenteditable nested inside another CE        no (only the outer host)
 *
 * Sensitive-field exclusion (password / email / autocomplete hints) is
 * UNCONDITIONAL — there is no settings flag that overrides it, and it is
 * checked before every other branch so it wins regardless of tag/role.
 */
export function isEditableElement(el: Element | HTMLElement | null | undefined): boolean {
    if (!el || !(el instanceof HTMLElement)) return false

    if (el.hasAttribute('data-grammarforge-ignore')) return false

    // Sensitive-field gate — unconditional, checked first, wins over every
    // other branch. `<input type="password">` is excluded by the type
    // allowlist below (password is simply not in EDITABLE_TEXT_INPUT_TYPES),
    // repeated here as an explicit fast-path so the intent reads plainly and
    // so a future change to EDITABLE_TEXT_INPUT_TYPES can't accidentally
    // re-admit it.
    if (el instanceof HTMLInputElement && (el.type || 'text').toLowerCase() === 'password') {
        return false
    }
    if (isSensitiveField(el)) return false

    if (el instanceof HTMLTextAreaElement) {
        return !el.readOnly && !el.disabled
    }

    if (el instanceof HTMLInputElement) {
        // Per HTML, an <input> with no type attribute defaults to type=text
        // (which IS editable). `el.type` falls back to "text" in that case.
        const t = (el.type || 'text').toLowerCase()
        if (!EDITABLE_TEXT_INPUT_TYPES.has(t)) return false
        return !el.readOnly && !el.disabled
    }

    if (isContentEditableTrue(el)) {
        // Nested-host check: if a contenteditable ancestor exists, this
        // element is part of the host's content, not an independent field.
        return !hasEditableAncestor(el)
    }

    const role = el.getAttribute('role')
    if (role === 'textbox') return true

    const gEditable = el.getAttribute('g_editable')
    if (gEditable && gEditable !== 'false') return true

    return false
}
