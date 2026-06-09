// Shared red->green diff fragment: the original word(s) struck through in red,
// an arrow, then the corrected word(s) in green (e.g. "was" -> "were"). Used by
// the hover tooltip, the click popover, and the pill "Apply all" panel so the
// preview looks identical everywhere. Returns an HTML string (the callers set
// innerHTML inside a closed shadow root); all dynamic text is escaped.

export function escapeText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Render a word-level diff preview. `original` is shown red + struck-through;
 * `corrected` green. When `isDeletion` is true (the correction removes the
 * text) the green side is replaced with a muted "removed" marker.
 */
export function diffInnerHTML(original: string, corrected: string, isDeletion: boolean): string {
    const oldPart = `<span class="gf-diff__old">${escapeText(original)}</span>`
    const arrow = `<span class="gf-diff__arrow" aria-hidden="true">&rarr;</span>`
    const rightPart = isDeletion
        ? `<span class="gf-diff__removed">removed</span>`
        : `<span class="gf-diff__new">${escapeText(corrected)}</span>`
    return `<span class="gf-diff">${oldPart} ${arrow} ${rightPart}</span>`
}
