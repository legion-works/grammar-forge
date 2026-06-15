// Shared, rAF-coalesced scroll/resize re-anchor loop. One document-scroll
// (capture) + window-resize listener drives scheduleRemeasureAll; the
// rAF coalesces per-frame so an N-field page incurs N field updates per
// frame IN TOTAL, not N × (scroll-fires-per-frame). The per-field
// ResizeObserver (which observes THIS element's box, not the viewport)
// still routes here so a single-element resize also coalesces.
//
// The perf plan rewrites the per-field body in-place; this module's
// PUBLIC surface (mountReanchor) stays stable. The current shell is
// byte-equivalent to the orchestrator's previous inlined block — same
// rAF coalescing, same per-field measurement, same pill reposition.
// The orchestrator stitches item references back into the itemRects
// patch in setFieldState (the reanchor module never sees the items).

import { getSpanRectsBatch } from '@/overlay/rect'
import type { HighlightLayer, HighlightSpec } from '@/overlay/highlight'

export interface ReanchorFieldRects {
    rects: DOMRect[]
}

export interface ReanchorFieldState {
    items: Array<{ hlStart: number; hlEnd: number; category: string }>
    useNativeHighlight: boolean
    highlightLayer: HighlightLayer | null
    hoverItemIndex: number | null
    statusHandle: { reposition: (rect: DOMRect) => void } | null
}

export interface ReanchorDeps {
    /** Snapshot of every tracked field, iterated on every rAF. */
    getTrackedFields: () => Iterable<HTMLElement>
    /** Look up the FieldState for a given element. */
    getFieldState: (el: HTMLElement) => ReanchorFieldState | undefined
    /** Patch the field state after re-measure. The reanchor module writes
     *  the rects; the orchestrator stitches the `item` references back in
     *  (it owns the items list; the reanchor module doesn't see it). */
    setFieldState: (el: HTMLElement, patch: { itemRects: ReanchorFieldRects[] }) => void
    /** Called once per rAF when a scroll or resize fires. The orchestrator
     *  uses this to reposition (or close) all open floating surfaces
     *  (panel, popover, tooltip, synonyms, goals, rephrase card) that are
     *  anchored to a field or word rect. Floating surfaces are position:fixed
     *  and must be repositioned on every scroll/resize frame. */
    onScrollResize?: () => void
}

export function mountReanchor(deps: ReanchorDeps): { stop: () => void; schedule: () => void } {
    let remeasureScheduled = false
    const schedule = (): void => scheduleRemeasureAll()
    const remeasureField = (el: HTMLElement): void => {
        const st = deps.getFieldState(el)
        if (!st) return
        if (st.items.length > 0) {
            const spans = st.items.map((it) => ({ start: it.hlStart, end: it.hlEnd }))
            let allRects: DOMRect[][]
            try {
                allRects = getSpanRectsBatch(el, spans)
            } catch {
                // Measurement failed (detached node / odd layout) — leave
                // the prior rects in place and still reposition the pill
                // below. Same defensive behavior as the previous inlined
                // version (the known stale-on-throw gap is the perf
                // plan's problem).
                allRects = []
            }
            if (allRects.length > 0) {
                deps.setFieldState(el, {
                    itemRects: st.items.map((_, i) => ({ rects: allRects[i] ?? [] })),
                })
                if (!st.useNativeHighlight && st.highlightLayer) {
                    const specs: HighlightSpec[] = []
                    for (let i = 0; i < st.items.length; i++) {
                        for (const rect of allRects[i] ?? []) {
                            specs.push({
                                rect,
                                category: st.items[i]!.category as HighlightSpec['category'],
                                itemIndex: i,
                            })
                        }
                    }
                    st.highlightLayer.reconcile(specs)
                    st.highlightLayer.setState({
                        focused: document.activeElement === el,
                        hoverItemIndex: st.hoverItemIndex,
                    })
                }
            }
        }
        // Re-anchor the pill to the field's current position. Cheap;
        // runs even when there are no items so the pill tracks the
        // field whether or not it has suggestions.
        st.statusHandle?.reposition(el.getBoundingClientRect())
    }
    const scheduleRemeasureAll = (): void => {
        if (remeasureScheduled) return
        remeasureScheduled = true
        requestAnimationFrame(() => {
            remeasureScheduled = false
            for (const el of deps.getTrackedFields()) remeasureField(el)
            // Notify the orchestrator so it can reposition/close floating
            // surfaces (panel, popover, tooltip, synonyms, goals, rephrase
            // card) that are anchored to a field or word rect.
            deps.onScrollResize?.()
        })
    }
    document.addEventListener('scroll', scheduleRemeasureAll, { capture: true, passive: true })
    window.addEventListener('resize', scheduleRemeasureAll, { passive: true })
    return {
        schedule,
        stop: () => {
            document.removeEventListener('scroll', scheduleRemeasureAll, { capture: true })
            window.removeEventListener('resize', scheduleRemeasureAll)
        },
    }
}
