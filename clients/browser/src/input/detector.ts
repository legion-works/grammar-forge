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
// and the overlay would render nested underlines. The browser default
// <div contenteditable>…</div> uses one host; nested CE is a styling choice,
// not a separate field.

/** Attribute selectors that indicate a contenteditable ancestor. */
const CE_ANCESTOR_SELECTOR =
    '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

const EDITABLE_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
    'text',
    'search',
    'email',
    'url',
    'tel',
])

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
 *   <input type="text|search|email|url|tel">       yes (not readonly, not disabled)
 *   <input type="password|checkbox|submit|...">    no
 *   <input> (no type attr → defaults to text)      yes
 *   <x contenteditable="true" | "">                yes
 *   <x contenteditable="plaintext-only">            yes
 *   <x contenteditable="false" | "FALSE">          no
 *   <x contenteditable="inherit">                  no (only the host decides)
 *   <x role="textbox">                              yes
 *   <x g_editable="true"> (Google apps)             yes
 *   [data-grammarforge-ignore]                      no (opt-out, wins)
 *   null / non-Element                              no
 *   contenteditable nested inside another CE        no (only the outer host)
 */
export function isEditableElement(el: Element | HTMLElement | null | undefined): boolean {
    if (!el || !(el instanceof HTMLElement)) return false

    if (el.hasAttribute('data-grammarforge-ignore')) return false

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
