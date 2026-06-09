// Read the text content of an editable field, and apply a fix to it.
//
//   <textarea> / <input>            read/write .value (the host's one true buffer)
//   contenteditable                 read flattened textContent;
//                                   apply via Selection + document.execCommand('insertText')
//                                   to preserve the host editor's undo stack.
//
// jsdom limitation: document.execCommand('insertText') is a no-op (it does NOT
// mutate the DOM, even when overridden to return true). The contenteditable
// branch is therefore asserted via a spy on document.execCommand in the test,
// not by inspecting the post-fix DOM. The value-set path is fully testable.

export interface CodeUnitSpan {
    start: number
    end: number
}

/**
 * Read the current text of an editable element. Uses the field's own value
 * when available (.value for <textarea>/<input>) and falls back to flattened
 * textContent for contenteditable.
 */
export function getText(el: HTMLElement): string {
    if (el instanceof HTMLTextAreaElement) return el.value
    if (el instanceof HTMLInputElement) return el.value
    return el.textContent ?? ''
}

/**
 * Apply a fix (replace the code-unit span with `replacement`) in `el`. The
 * span is in UTF-16 code units (the same units the DOM uses); the caller is
 * responsible for byte→code-unit conversion (see @/api/offset).
 *
 * For <textarea>/<input> we set .value and dispatch a bubbling "input" event
 * so any host framework (React, Vue, Svelte) picks up the change.
 *
 * For contenteditable we set a Selection over the span and call
 * document.execCommand('insertText', false, replacement). This routes the
 * mutation through the host editor's input pipeline, which preserves the
 * native undo/redo stack and fires the right DOM events.
 */
export function applyFix(el: HTMLElement, span: CodeUnitSpan, replacement: string): void {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const cur = el.value
        const next = cur.slice(0, span.start) + replacement + cur.slice(span.end)
        el.value = next
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return
    }

    // contenteditable branch — Selection + execCommand to preserve undo.
    // The textContent path (textContent = ...) would work in jsdom but it
    // destroys the host's undo history, which is unacceptable in a real
    // browser.
    const sel = el.ownerDocument.getSelection()
    if (!sel) return
    const range = codeUnitSpanToRange(el, span)
    if (!range) return
    sel.removeAllRanges()
    sel.addRange(range)
    el.ownerDocument.execCommand('insertText', false, replacement)
}

/**
 * Map a [start,end) code-unit span on the flattened textContent of `el` to a
 * DOM Range. Returns null if the span is out of range (caller should drop).
 * Exported so the native highlighter (overlay/native-highlight.ts) can build
 * DOM Ranges from the same UTF-16 code-unit offsets that `applyFix` uses.
 */
export function codeUnitSpanToRange(el: HTMLElement, span: CodeUnitSpan): Range | null {
    const text = el.textContent ?? ''
    if (span.start < 0 || span.end < span.start || span.start > text.length) return null

    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let consumed = 0
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0

    let node = walker.nextNode()
    while (node) {
        const t = node as Text
        const len = t.data.length
        const nodeStart = consumed
        const nodeEnd = consumed + len
        if (startNode == null && nodeStart <= span.start && span.start <= nodeEnd) {
            startNode = t
            startOffset = span.start - nodeStart
        }
        if (nodeStart <= span.end && span.end <= nodeEnd) {
            endNode = t
            endOffset = span.end - nodeStart
            break
        }
        consumed = nodeEnd
        node = walker.nextNode()
    }

    if (!startNode || !endNode) return null
    const range = el.ownerDocument.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
}
