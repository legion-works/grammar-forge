// Word-level diff for display. The bridge returns minimal (often character-
// level) edit spans — e.g. "was" -> "were" comes back as the span "as" -> "ere".
// For a readable preview ("was -> were", original in red, correction in green)
// we expand the edit to the surrounding whole word(s) and compute the original
// vs corrected word text. This is a DISPLAY concern only: applying a fix still
// uses the exact edit span + replacement (see input/text.applyFix), so the
// expansion never affects what gets written to the field.

export interface WordDiff {
    /** The whole-word(s) original text covering the edit span. */
    original: string
    /** The same window with the edit applied (the corrected word(s)). */
    corrected: string
    /** True when the correction removes the text (empty/whitespace corrected). */
    isDeletion: boolean
    /** Code-unit range of the surrounding whole word(s) — what to HIGHLIGHT.
     *  The raw edit span [cuStart,cuEnd) can be ZERO-WIDTH (e.g. inserting a
     *  letter: "sw" -> "saw" is an insert at one offset), which has no rect and
     *  so can't be highlighted. This expanded range covers the affected word so
     *  the highlight (and hover/click hit-test) lands on it. Apply still uses
     *  the raw edit span. Equals [editStart,editEnd] when the edit is not inside
     *  a word (e.g. an insertion at a whitespace boundary). */
    wordStart: number
    wordEnd: number
}

function isBoundary(ch: string | undefined): boolean {
    // Word boundary = whitespace. Punctuation is intentionally NOT a boundary
    // so "don't" / "U.S." stay whole; the bridge edit span decides the rest.
    return ch === undefined || /\s/.test(ch)
}

/**
 * Expand the edit [cuStart, cuEnd) (UTF-16 code units into `text`) with its
 * `replacement` to the surrounding whole word(s) and return the original vs
 * corrected word text for a preview. Offsets are clamped; an out-of-range span
 * yields a best-effort window. Pure — no DOM, no side effects.
 */
export function wordLevelDiff(
    text: string,
    cuStart: number,
    cuEnd: number,
    replacement: string,
): WordDiff {
    const len = text.length
    const editStart = Math.max(0, Math.min(cuStart, len))
    const editEnd = Math.max(editStart, Math.min(cuEnd, len))

    // Expand to the nearest whitespace boundary so the preview shows the whole
    // word — but ONLY when the edit actually starts/ends INSIDE a word.
    // Otherwise an edit that ends on a boundary (e.g. deleting "has " incl. its
    // trailing space) would wrongly swallow the following word.
    const startsInWord =
        editEnd > editStart
            ? !isBoundary(text[editStart])
            : editStart > 0 && !isBoundary(text[editStart - 1])
    const endsInWord =
        editEnd > editStart ? !isBoundary(text[editEnd - 1]) : !isBoundary(text[editEnd])

    let wordStart = editStart
    if (startsInWord) {
        while (wordStart > 0 && !isBoundary(text[wordStart - 1])) wordStart--
    }
    let wordEnd = editEnd
    if (endsInWord) {
        while (wordEnd < len && !isBoundary(text[wordEnd])) wordEnd++
    }

    const original = text.slice(wordStart, wordEnd)
    const corrected = text.slice(wordStart, editStart) + replacement + text.slice(editEnd, wordEnd)
    return {
        original,
        corrected,
        isDeletion: corrected.trim().length === 0,
        wordStart,
        wordEnd,
    }
}
