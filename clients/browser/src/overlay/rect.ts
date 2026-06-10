// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Map a (code-unit) span over a text-bearing DOM element to viewport rects.
// Two strategies:
//   1. textarea / input  -> mirror-div technique: clone the element's font/
//      padding/border/width into a hidden div, splice a marker span over the
//      text range, and read the marker's getBoundingClientRect().
//   2. contenteditable  -> build a Range over the code-unit offsets via the
//      SHARED flat-text mapping (input/text.ts codeUnitSpansToRanges — the
//      line-aware model with virtual newlines at <br>/block boundaries) and
//      return Range.getClientRects().
//
// jsdom limitation: jsdom does not lay out pages, so neither strategy yields
// meaningful pixel coordinates. The mirror-div path is exercised by inspecting
// the styles it COPIES onto the hidden div (the math is independent of layout);
// the contenteditable path is exercised with a Range.getClientRects spy.

import { codeUnitSpansToRanges } from '@/input/text'

export interface MirrorProbe {
    element: HTMLDivElement
    marker: HTMLSpanElement
    remove: () => void
}

// P1/H1: cache the mirror's derived cssText string per element. Rebuilding it
// (a getComputedStyle read + string concat) on every measure was the dominant
// textarea cost. The cache key is a cheap box/style signature; when it changes
// (font/size/width) we rebuild. A WeakMap keys by the element so detached
// fields are GC'd.
interface CachedMirrorStyle {
    signature: string
    style: string
}
const mirrorStyleCache = new WeakMap<HTMLElement, CachedMirrorStyle>()

function mirrorStyleSignature(el: HTMLElement, computed: CSSStyleDeclaration): string {
    return [
        el.offsetWidth,
        computed.fontFamily,
        computed.fontSize,
        computed.fontWeight,
        computed.lineHeight,
        computed.letterSpacing,
        computed.padding,
        computed.border,
    ].join('|')
}

function mirrorStyleFor(el: HTMLTextAreaElement | HTMLInputElement): string {
    const computed = el.ownerDocument.defaultView!.getComputedStyle(el)
    const signature = mirrorStyleSignature(el, computed)
    const cached = mirrorStyleCache.get(el)
    if (cached && cached.signature === signature) return cached.style
    const style = [
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
    mirrorStyleCache.set(el, { signature, style })
    return style
}

/** Test-only: force a cache resolution for `el` and return the cssText string. */
export function __mirrorStyleForTest(el: HTMLTextAreaElement | HTMLInputElement): string {
    return mirrorStyleFor(el)
}

// PRIVACY: the mirror div contains the user's FULL field text. It must never
// be appended to the page-visible DOM — a page script with a MutationObserver
// on body receives the added node in its records and can read the text from
// the retained reference even after the mirror is removed (exfiltration of
// everything typed in any monitored field; privacy invariant #1). Instead,
// mirrors are appended into a CLOSED shadow root on a zero-size host: layout
// still runs (shadow DOM renders normally, unlike a detached document), but
// page observers only ever see the empty host element — `host.shadowRoot` is
// null in closed mode and Element.textContent does not traverse shadow trees.
// The host is module-level and lazily (re)created when missing or when the
// document changed (vitest/jsdom recreates the DOM between test files).
let measurementRoot: ShadowRoot | null = null

function getMeasurementRoot(doc: Document): ShadowRoot {
    if (
        measurementRoot &&
        measurementRoot.host.isConnected &&
        measurementRoot.host.ownerDocument === doc
    ) {
        return measurementRoot
    }
    const host = doc.createElement('div')
    // Zero-size, non-interactive anchor. The mirror inside positions itself
    // absolutely at -9999px relative to this (positioned) host; all rect math
    // uses marker-vs-mirror RELATIVE offsets, so host placement is irrelevant.
    host.style.cssText =
        'position:absolute;top:0;left:0;width:0;height:0;overflow:visible;pointer-events:none'
    measurementRoot = host.attachShadow({ mode: 'closed' })
    doc.body.appendChild(host)
    return measurementRoot
}

/**
 * Build a hidden mirror <div> that copies the font / box / width of a text
 * input so we can measure text in pixels. The returned probe owns a
 * `marker` <span> positioned at `[cuStart, cuEnd]`; after appending the
 * probe, the marker's getBoundingClientRect() reflects the visual position
 * of that range inside the input.
 *
 * PRIVACY: the probe contains the field's full text. Append it ONLY into
 * the closed-shadow measurement root (see getMeasurementRoot), never into
 * the page-visible DOM. The probe MUST be removed (via `remove()`) after
 * measurement.
 */
export function buildMirrorProbe(
    el: HTMLTextAreaElement | HTMLInputElement,
    cuStart: number,
    cuEnd: number,
): MirrorProbe {
    const doc = el.ownerDocument
    const text = el.value
    const start = Math.max(0, Math.min(cuStart, text.length))
    const end = Math.max(start, Math.min(cuEnd, text.length))

    const mirror = doc.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    mirror.style.cssText = mirrorStyleFor(el)

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
    return getRangeRectsBatch(el, spans)
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

    const mirror = owner.createElement('div')
    mirror.setAttribute('aria-hidden', 'true')
    mirror.style.cssText = mirrorStyleFor(el)

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

    // Closed-shadow measurement root, NOT owner.body — see getMeasurementRoot.
    getMeasurementRoot(owner).appendChild(mirror)
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
    // Closed-shadow measurement root, NOT owner.body — see getMeasurementRoot.
    getMeasurementRoot(owner).appendChild(probe.element)
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
    const [rects] = getRangeRectsBatch(el, [{ start: cuStart, end: cuEnd }])
    return rects ?? []
}

/**
 * Batch contenteditable rect resolution: map every span to a DOM Range via
 * the SHARED flat-text model (input/text.ts — one segment walk for the whole
 * batch, virtual newlines included so offsets agree with getText/applyFix),
 * then read each Range's client rects.
 *
 * jsdom does not implement Range.getClientRects (no layout engine); the
 * per-range feature check makes every span yield a clean [] in tests.
 */
function getRangeRectsBatch(el: HTMLElement, spans: readonly CodeUnitSpan[]): DOMRect[][] {
    if (spans.length === 0) return []
    const ranges = codeUnitSpansToRanges(el, spans)
    return ranges.map((range) => {
        if (!range) return []
        try {
            return typeof range.getClientRects === 'function'
                ? Array.from(range.getClientRects())
                : []
        } catch {
            return []
        } finally {
            range.detach?.()
        }
    })
}
