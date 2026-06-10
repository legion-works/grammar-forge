// Read the text content of an editable field, and apply a fix to it.
//
//   <textarea> / <input>            read/write .value (the host's one true buffer)
//   contenteditable                 read the LINE-AWARE flattened text (below);
//                                   apply via Selection + document.execCommand('insertText')
//                                   to preserve the host editor's undo stack.
//
// THE FLAT TEXT MODEL (contenteditable). Element.textContent inserts NO
// separator between block elements (`<div>Zix</div><div>Vrak</div>` →
// "ZixVrak"), so a flat model built on it joins the last word of one line
// with the first word of the next — the bridge then flags the joined token
// as ONE word and the highlight spans the visual line break (verified live).
// Instead, the flat text contains VIRTUAL NEWLINES: a `<br>` contributes
// "\n", and closing a block-level element contributes "\n" (deduped, one
// trailing "\n" stripped). Every offset consumer — getText, applyFix /
// codeUnitSpanToRange, the rect measurement (overlay/rect.ts), the native
// highlighter (overlay/native-highlight.ts), and the selection mapping
// (domPointToFlatOffset) — derives from the SAME segment walk
// (flatSegments), so offsets agree by construction. Range.toString() and
// textContent must NOT be mixed into this model: both lack the separators.
//
// jsdom limitation: document.execCommand('insertText') is a no-op (it does NOT
// mutate the DOM, even when overridden to return true). The contenteditable
// branch is therefore asserted via a spy on document.execCommand in the test,
// not by inspecting the post-fix DOM. The value-set path is fully testable.

export interface CodeUnitSpan {
    start: number
    end: number
}

/** Elements whose CLOSE contributes a virtual "\n" to the flat text. A
 *  tag-based approximation of CSS block layout — deterministic and
 *  layout-independent (innerText would be layout-aware but forces reflow
 *  and cannot be offset-mapped back to DOM positions). Covers the block
 *  containers rich editors actually emit (div/p per line, li, headings). */
const BLOCK_TAGS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DETAILS',
    'DIV',
    'DL',
    'DT',
    'FIELDSET',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TD',
    'TH',
    'TR',
    'UL',
])

/**
 * One piece of the flat text: a real DOM Text node, or a virtual newline (a
 * "\n" that exists in the flat model but not in any text node — emitted for
 * `<br>` and at block-element boundaries). Newline segments carry a DOM
 * boundary anchor (the position just AFTER the `<br>` / closing block in its
 * parent) used only as a last-resort Range anchor; span endpoints that land
 * on a virtual newline prefer the adjacent text nodes (see resolve*Point).
 */
interface FlatSegment {
    kind: 'text' | 'newline'
    /** Flat code-unit offset where this segment starts. */
    flatStart: number
    /** kind=text: node.data.length (may be 0); kind=newline: 1. */
    length: number
    /** kind=text only. */
    node: Text | null
    /** kind=newline only: boundary anchor (container, offset). */
    anchorContainer: Node | null
    anchorOffset: number
}

/**
 * Walk `el`'s subtree in document order and produce the flat-text segments.
 * The SINGLE source of truth for the contenteditable text model — getText,
 * the span→Range mapping, and the selection→offset mapping all consume it.
 */
function flatSegments(el: HTMLElement): FlatSegment[] {
    const segments: FlatSegment[] = []
    let flatLength = 0
    const endsWithNewline = (): boolean =>
        segments.length > 0 && segments[segments.length - 1]!.kind === 'newline'
    const pushNewline = (container: Node, offset: number): void => {
        segments.push({
            kind: 'newline',
            flatStart: flatLength,
            length: 1,
            node: null,
            anchorContainer: container,
            anchorOffset: offset,
        })
        flatLength += 1
    }
    const boundaryAfter = (node: Node): { container: Node; offset: number } | null => {
        const parent = node.parentNode
        if (!parent) return null
        let index = 0
        for (let c = parent.firstChild; c && c !== node; c = c.nextSibling) index++
        return { container: parent, offset: index + 1 }
    }
    const walk = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = node as Text
            segments.push({
                kind: 'text',
                flatStart: flatLength,
                length: t.data.length,
                node: t,
                anchorContainer: null,
                anchorOffset: 0,
            })
            flatLength += t.data.length
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const element = node as Element
        if (element.tagName === 'BR') {
            const b = boundaryAfter(element)
            if (b) pushNewline(b.container, b.offset)
            return
        }
        for (let c = element.firstChild; c; c = c.nextSibling) walk(c)
        // Closing a block contributes one "\n" — only when there is content
        // before it and the buffer doesn't already end with a newline (two
        // adjacent block closes yield ONE separator, like the browser).
        if (BLOCK_TAGS.has(element.tagName) && flatLength > 0 && !endsWithNewline()) {
            const b = boundaryAfter(element)
            if (b) pushNewline(b.container, b.offset)
        }
    }
    for (let c = el.firstChild; c; c = c.nextSibling) walk(c)
    // A trailing block close adds no line — strip exactly one trailing "\n"
    // so `<div>a</div>` flattens to "a" and `<div>a</div><div>b</div>` to "a\nb".
    if (endsWithNewline()) segments.pop()
    return segments
}

function flatLengthOf(segments: FlatSegment[]): number {
    const last = segments[segments.length - 1]
    return last ? last.flatStart + last.length : 0
}

/**
 * Read the current text of an editable element. Uses the field's own value
 * when available (.value for <textarea>/<input>) and the line-aware flat
 * model (virtual newlines at <br> / block boundaries) for contenteditable.
 */
export function getText(el: HTMLElement): string {
    if (el instanceof HTMLTextAreaElement) return el.value
    if (el instanceof HTMLInputElement) return el.value
    let out = ''
    for (const s of flatSegments(el)) {
        out += s.kind === 'newline' ? '\n' : s.node!.data
    }
    return out
}

/** Last text segment strictly before index `i`, or null. */
function lastTextSegmentBefore(segments: FlatSegment[], i: number): FlatSegment | null {
    for (let k = i - 1; k >= 0; k--) {
        if (segments[k]!.kind === 'text') return segments[k]!
    }
    return null
}

/** First text segment strictly after index `i`, or null. */
function firstTextSegmentAfter(segments: FlatSegment[], i: number): FlatSegment | null {
    for (let k = i + 1; k < segments.length; k++) {
        if (segments[k]!.kind === 'text') return segments[k]!
    }
    return null
}

interface DomPoint {
    container: Node
    offset: number
}

/**
 * Resolve a span START offset to a DOM point. Half-open semantics: the
 * offset binds to the segment it is INSIDE (`flatStart <= off <
 * flatStart+length`), so a start at a text-node boundary lands at the START
 * of the following node. `off === flat length` resolves to the end of the
 * final segment. A start ON a virtual newline anchors at the END of the
 * preceding text node (so a Range starting there covers the line boundary),
 * falling back to the newline's structural anchor.
 */
function resolveStartPoint(segments: FlatSegment[], off: number): DomPoint | null {
    const total = flatLengthOf(segments)
    if (off < 0 || off > total) return null
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!
        if (off >= s.flatStart + s.length) continue
        if (s.kind === 'text') return { container: s.node!, offset: off - s.flatStart }
        const prev = lastTextSegmentBefore(segments, i)
        if (prev) return { container: prev.node!, offset: prev.length }
        return { container: s.anchorContainer!, offset: s.anchorOffset }
    }
    // off === total: the end of the last text segment (or newline anchor).
    for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i]!
        if (s.kind === 'text') return { container: s.node!, offset: s.length }
        return { container: s.anchorContainer!, offset: s.anchorOffset }
    }
    return null
}

/**
 * Resolve a span END offset to a DOM point. Half-open semantics mirrored:
 * the offset binds to the segment it CLOSES (`flatStart < off <=
 * flatStart+length`), so an end at a text-node boundary lands at the END of
 * the preceding node (single-line spans stay inside one text node). An end
 * just past a virtual newline anchors at the START of the following text
 * node, falling back to the structural anchor.
 */
function resolveEndPoint(segments: FlatSegment[], off: number): DomPoint | null {
    const total = flatLengthOf(segments)
    if (off < 0 || off > total) return null
    if (off === 0) return resolveStartPoint(segments, 0)
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i]!
        if (off > s.flatStart + s.length) continue
        if (off <= s.flatStart) break
        if (s.kind === 'text') return { container: s.node!, offset: off - s.flatStart }
        const next = firstTextSegmentAfter(segments, i)
        if (next) return { container: next.node!, offset: 0 }
        return { container: s.anchorContainer!, offset: s.anchorOffset }
    }
    return null
}

/**
 * Batch-map [start,end) code-unit spans on the flat text of `el` to DOM
 * Ranges (null per unmappable span). One segment walk for the whole batch.
 * A span crossing a virtual newline yields a cross-block Range — applying a
 * fix over it merges the lines, which is the correct edit semantics.
 */
export function codeUnitSpansToRanges(
    el: HTMLElement,
    spans: readonly CodeUnitSpan[],
): Array<Range | null> {
    const segments = flatSegments(el)
    const doc = el.ownerDocument
    return spans.map((span) => {
        if (span.start < 0 || span.end < span.start) return null
        const start = resolveStartPoint(segments, span.start)
        // A collapsed span uses ONE point for both ends (mixing the start/end
        // boundary preferences at a node seam would order end before start).
        const end = span.end === span.start ? start : resolveEndPoint(segments, span.end)
        if (!start || !end) return null
        try {
            const range = doc.createRange()
            range.setStart(start.container, start.offset)
            range.setEnd(end.container, end.offset)
            return range
        } catch {
            return null
        }
    })
}

/**
 * Map a [start,end) code-unit span on the flat text of `el` to a DOM Range.
 * Returns null if the span is out of range (caller should drop). Exported so
 * the native highlighter (overlay/native-highlight.ts) and the rect
 * measurement (overlay/rect.ts) build Ranges from the same flat offsets that
 * `getText`/`applyFix` use.
 */
export function codeUnitSpanToRange(el: HTMLElement, span: CodeUnitSpan): Range | null {
    return codeUnitSpansToRanges(el, [span])[0] ?? null
}

/**
 * Inverse mapping for selections: a DOM point (container, offset) → its flat
 * code-unit offset in `el`'s flat text model. Text-node containers resolve
 * exactly; an Element container resolves to the flat offset of the first
 * text content at-or-after the boundary before its `offset`-th child (end of
 * `el` → the flat length). Returns null when the container is outside `el`
 * or contributes no position.
 */
export function domPointToFlatOffset(
    el: HTMLElement,
    container: Node,
    offset: number,
): number | null {
    if (container !== el && !el.contains(container)) return null
    const segments = flatSegments(el)
    const total = flatLengthOf(segments)
    if (container.nodeType === Node.TEXT_NODE) {
        for (const s of segments) {
            if (s.kind === 'text' && s.node === container) {
                return s.flatStart + Math.min(offset, s.length)
            }
        }
        return null
    }
    if (container.nodeType !== Node.ELEMENT_NODE) return null
    const children = container.childNodes
    const ref = offset < children.length ? children[offset]! : null
    for (const s of segments) {
        if (s.kind !== 'text') continue
        const n = s.node!
        if (ref) {
            // First text node at-or-after the boundary (not strictly
            // preceding the reference child) carries the boundary's offset.
            const pos = ref.compareDocumentPosition(n)
            const precedes = (pos & Node.DOCUMENT_POSITION_PRECEDING) !== 0
            if (!precedes) return s.flatStart
        } else {
            // Boundary at the END of `container`: the first text node fully
            // after the container (not inside it).
            const pos = container.compareDocumentPosition(n)
            const following = (pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            const inside = (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) !== 0
            if (following && !inside) return s.flatStart
        }
    }
    return total
}

/**
 * Apply a fix (replace the code-unit span with `replacement`) in `el`. The
 * span is in UTF-16 code units of the flat text model (the same units
 * getText returns); the caller is responsible for byte→code-unit conversion
 * (see @/api/offset).
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
