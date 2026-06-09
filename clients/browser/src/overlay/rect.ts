// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Map a (code-unit) span over a text-bearing DOM element to viewport rects.
// Two strategies:
//   1. textarea / input  -> mirror-div technique: clone the element's font/
//      padding/border/width into a hidden div, splice a marker span over the
//      text range, and read the marker's getBoundingClientRect().
//   2. contenteditable  -> build a Range over the code-unit offsets (via a
//      TextNode TreeWalker) and return Range.getClientRects().
//
// jsdom limitation: jsdom does not lay out pages, so neither strategy yields
// meaningful pixel coordinates. The mirror-div path is exercised by inspecting
// the styles it COPIES onto the hidden div (the math is independent of layout);
// the contenteditable path is exercised with a Range.getClientRects spy.

export interface MirrorProbe {
    element: HTMLDivElement
    marker: HTMLSpanElement
    remove: () => void
}

/**
 * Resolve a flat code-unit offset within a contenteditable (or any element
 * containing text nodes) to the concrete Text node + the offset within it.
 * Returns null if the offset is past the end of the concatenated text.
 */
export function findTextNodeForOffset(
    root: Element,
    codeUnitOffset: number,
): { node: Text; offset: number } | null {
    if (codeUnitOffset < 0) return null
    const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let consumed = 0
    let node = walker.nextNode() as Text | null
    while (node) {
        const len = node.length
        if (codeUnitOffset <= consumed + len) {
            return { node, offset: codeUnitOffset - consumed }
        }
        consumed += len
        node = walker.nextNode() as Text | null
    }
    return null
}

/**
 * Build a hidden mirror <div> that copies the font / box / width of a text
 * input so we can measure text in pixels. The returned probe owns a
 * `marker` <span> positioned at `[cuStart, cuEnd]`; after appending the
 * probe to the document, the marker's getBoundingClientRect() reflects
 * the visual position of that range inside the input.
 *
 * The probe MUST be removed (via `remove()`) after measurement; leaving it
 * in the DOM causes visual glitches.
 */
export function buildMirrorProbe(
    el: HTMLTextAreaElement | HTMLInputElement,
    cuStart: number,
    cuEnd: number,
): MirrorProbe {
    const doc = el.ownerDocument
    const computed = doc.defaultView!.getComputedStyle(el)
    const text = el.value
    const start = Math.max(0, Math.min(cuStart, text.length))
    const end = Math.max(start, Math.min(cuEnd, text.length))

    const mirror = doc.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    mirror.style.cssText = [
        'position: absolute',
        'top: -9999px',
        'left: -9999px',
        'visibility: hidden',
        'pointer-events: none',
        'white-space: pre-wrap',
        'word-wrap: break-word',
        'overflow: hidden',
        `width: ${el.offsetWidth}px`,
        `font-family: ${computed.fontFamily}`,
        `font-size: ${computed.fontSize}`,
        `font-weight: ${computed.fontWeight}`,
        `line-height: ${computed.lineHeight}`,
        `letter-spacing: ${computed.letterSpacing}`,
        `padding: ${computed.padding}`,
        `border: ${computed.border}`,
    ].join('; ')

    const before = doc.createElement('span')
    before.textContent = text.substring(0, start)
    const marker = doc.createElement('span')
    marker.textContent = text.substring(start, end)
    const after = doc.createElement('span')
    after.textContent = text.substring(end)

    mirror.append(before, marker, after)
    return {
        element: mirror,
        marker,
        remove: () => mirror.remove(),
    }
}

/**
 * Compute viewport rects covering a [cuStart, cuEnd] code-unit span within
 * `el`. For <textarea> / <input> the mirror-div technique is used; for any
 * other element (contenteditable, [g_editable], etc.) a Range is built over
 * the resolved text nodes. Returns an empty array on any failure (caller
 * skips the highlight).
 *
 * Thin wrapper kept for back-compat with existing call sites and tests —
 * prefer `getSpanRectsBatch` when more than one span is being measured
 * (one mirror build + one layout flush for the whole batch instead of
 * one per span).
 */
export function getSpanRects(el: HTMLElement, cuStart: number, cuEnd: number): DOMRect[] {
    if (cuEnd <= cuStart) return []
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return getInputMirrorRects(el, cuStart, cuEnd)
    }
    return getRangeRects(el, cuStart, cuEnd)
}

/** A code-unit span on the flat text content of an element. */
export interface CodeUnitSpan {
    start: number
    end: number
}

/**
 * Batch version of getSpanRects. Returns one DOMRect[] per input span, in
 * the same order. For <textarea> / <input> the mirror div is built ONCE
 * (one computed-style copy, one DOM append, one layout flush, one remove)
 * and one marker span per non-empty span is appended into the same
 * mirror — so k suggestions on the same field cost O(1) layout flushes
 * instead of O(k).
 *
 * For contenteditable, each span is resolved with its own Range (Range is
 * a one-shot object; reusing one across spans would require mutating its
 * endpoints anyway). This is still cheaper than the per-span mirror path
 * because the contenteditable path never touches the DOM.
 */
export function getSpanRectsBatch(el: HTMLElement, spans: readonly CodeUnitSpan[]): DOMRect[][] {
    if (spans.length === 0) return []
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return getInputMirrorRectsBatch(el, spans)
    }
    return spans.map((s) => getRangeRects(el, s.start, s.end))
}

function getInputMirrorRectsBatch(
    el: HTMLTextAreaElement | HTMLInputElement,
    spans: readonly CodeUnitSpan[],
): DOMRect[][] {
    const text = el.value
    const owner = el.ownerDocument

    // Pre-clamp every span and remember the (start, end) pairs we actually
    // need to render. A clamped-to-zero-width span still occupies a slot
    // in the output (the caller expects one inner array per input span)
    // but contributes no marker span.
    type Slot = { start: number; end: number; outIndex: number }
    const slots: Slot[] = []
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i]!
        const start = Math.max(0, Math.min(s.start, text.length))
        const end = Math.max(start, Math.min(s.end, text.length))
        slots.push({ start, end, outIndex: i })
    }

    // Build the mirror ONCE: copy computed style + sizing into a single
    // hidden div. We then append a `before` + N marker spans + a single
    // `after` span that picks up at the maximum end-offset seen. The
    // layout engine will compute the marker's box during a SINGLE reflow.
    const usable = slots.filter((s) => s.end > s.start)
    if (usable.length === 0) {
        return spans.map(() => [])
    }

    const minStart = Math.min(...usable.map((s) => s.start))
    const maxEnd = Math.max(...usable.map((s) => s.end))

    const computed = owner.defaultView!.getComputedStyle(el)
    const mirror = owner.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    mirror.style.cssText = [
        'position: absolute',
        'top: -9999px',
        'left: -9999px',
        'visibility: hidden',
        'pointer-events: none',
        'white-space: pre-wrap',
        'word-wrap: break-word',
        'overflow: hidden',
        `width: ${el.offsetWidth}px`,
        `font-family: ${computed.fontFamily}`,
        `font-size: ${computed.fontSize}`,
        `font-weight: ${computed.fontWeight}`,
        `line-height: ${computed.lineHeight}`,
        `letter-spacing: ${computed.letterSpacing}`,
        `padding: ${computed.padding}`,
        `border: ${computed.border}`,
    ].join('; ')

    const before = owner.createElement('span')
    before.textContent = text.substring(0, minStart)
    mirror.appendChild(before)

    // Sort by start so the per-span `before` text accumulates correctly.
    const sorted = [...usable].sort((a, b) => a.start - b.start)
    const markers: HTMLSpanElement[] = []
    let cursor = minStart
    for (const s of sorted) {
        if (s.start > cursor) {
            // fill the gap with whitespace-equivalent text so the marker
            // span's left position is computed against the real preceding
            // characters.
            const gap = owner.createElement('span')
            gap.textContent = text.substring(cursor, s.start)
            mirror.appendChild(gap)
        }
        const marker = owner.createElement('span')
        marker.textContent = text.substring(s.start, s.end)
        mirror.appendChild(marker)
        markers.push(marker)
        cursor = s.end
    }
    const after = owner.createElement('span')
    after.textContent = text.substring(maxEnd)
    mirror.appendChild(after)

    owner.body.appendChild(mirror)
    try {
        const elRect = el.getBoundingClientRect()
        const mirrorRect = mirror.getBoundingClientRect()
        const scrollTop = el.scrollTop || 0
        const scrollLeft = el.scrollLeft || 0

        // Read all marker rects in one tick — the browser has already
        // flushed layout for the appended mirror div, so the N calls
        // below don't trigger additional reflows.
        const rectsByMarker = markers.map((m) => m.getBoundingClientRect())

        const out: DOMRect[][] = spans.map(() => [])
        for (let i = 0; i < sorted.length; i++) {
            const slot = sorted[i]!
            const markerRect = rectsByMarker[i]!
            const left = elRect.left + (markerRect.left - mirrorRect.left) - scrollLeft
            const top = elRect.top + (markerRect.top - mirrorRect.top) - scrollTop
            out[slot.outIndex] = [new DOMRect(left, top, markerRect.width, markerRect.height)]
        }
        return out
    } finally {
        mirror.remove()
    }
}

function getInputMirrorRects(
    el: HTMLTextAreaElement | HTMLInputElement,
    cuStart: number,
    cuEnd: number,
): DOMRect[] {
    // buildMirrorProbe clamps internally, but if the (clamped) range
    // collapses to zero width we should bail before touching the DOM —
    // matches the contenteditable path's behaviour above and prevents
    // rendering a 0-wide highlight for spans that landed past the text.
    const text = el.value
    const start = Math.max(0, Math.min(cuStart, text.length))
    const end = Math.max(start, Math.min(cuEnd, text.length))
    if (end <= start) return []

    const probe = buildMirrorProbe(el, cuStart, cuEnd)
    const owner = el.ownerDocument
    owner.body.appendChild(probe.element)
    try {
        const markerRect = probe.marker.getBoundingClientRect()
        const mirrorRect = probe.element.getBoundingClientRect()
        const elRect = el.getBoundingClientRect()
        const scrollTop = el.scrollTop || 0
        const scrollLeft = el.scrollLeft || 0
        const left = elRect.left + (markerRect.left - mirrorRect.left) - scrollLeft
        const top = elRect.top + (markerRect.top - mirrorRect.top) - scrollTop
        return [new DOMRect(left, top, markerRect.width, markerRect.height)]
    } finally {
        probe.remove()
    }
}

function getRangeRects(el: HTMLElement, cuStart: number, cuEnd: number): DOMRect[] {
    const start = findTextNodeForOffset(el, cuStart)
    const end = findTextNodeForOffset(el, cuEnd)
    if (!start || !end) return []
    const range = el.ownerDocument.createRange()
    try {
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
        // jsdom does not implement Range.getClientRects (no layout engine);
        // guard so the caller still gets a clean [] in test environments.
        if (typeof range.getClientRects !== 'function') return []
        return Array.from(range.getClientRects())
    } catch {
        return []
    } finally {
        range.detach?.()
    }
}
