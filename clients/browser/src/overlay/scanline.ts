// Streaming fast→slow scan-line. The bridge returns a `fast` preview frame
// (Harper + GECToR + cached LLM) followed by a `final` LLM frame; while the
// field is in `phase === 'fast'`, a thin horizontal sweep travels top→bottom
// of the field to signal "AI is still refining." On `phase === 'done'`
// (final frame or stream error) the scan-line is removed.
//
// The CSS for `.gf-scanline` + the `gf-scan` keyframe lives in styles.ts
// (design-system rule; the line animates opacity, which the design comment
// calls out as the only opacity-animated surface). The element is
// `position: absolute; left: 0; right: 0; height: 64px;` and the keyframe
// moves `top` from -2% to 102% of its containing block.
//
// Mounting rule: the scan-line is positioned inside a wrapper anchored to
// the field's viewport rect (measured BEFORE any rerender — the
// measure-before-rerender gotcha from flows.md §3). The wrapper gives the
// scan-line a containing block with an established height (the keyframe's
// `top: -2%` / `top: 102%` resolve against it). The wrapper itself uses
// `position: fixed` so it anchors to the viewport — the shadow host has no
// `transform`/`filter` ancestor that would trap `fixed` children, and a
// field-relative rect (viewport coords) is the natural fit for the
// `gf-scan` sweep. The scan-line is per-field: mounting for field A does
// not interfere with field B's rect, and `removeScanline` is idempotent so
// a second call is a no-op (no leak across phase transitions or teardown).
import type { OverlayHost } from '@/overlay/shadow-host'

export interface ScanlineHandle {
    /** Whether the wrapper is still in the shadow root. */
    isMounted: () => boolean
    /**
     * Re-anchor the wrapper to a fresh field rect. Cheap (writes four inline
     * styles); intended for callers that re-render the field on layout
     * change (e.g. text wrapping added a line). The scan-line's `gf-scan`
     * keyframe continues uninterrupted — the wrapper moves, the line keeps
     * sweeping relative to it.
     */
    update: (fieldRect: DOMRect) => void
    /**
     * Detach the wrapper from the shadow root. Idempotent.
     */
    remove: () => void
}

/**
 * Mount a scan-line in the given shadow root, anchored to the supplied
 * field rect. Returns a handle the orchestrator keeps on its per-field
 * state for `update`/`remove`. Per-field scoping: a second call while a
 * handle is already mounted for the same root is the caller's job (the
 * orchestrator keys on `state.phase` + a per-field handle slot, so two
 * fields can each have their own scan-line in the same shadow root).
 *
 * `host` is the overlay host (the value returned by `createOverlayHost`).
 * The wrapper is appended to the host's shadow root, alongside the other
 * overlay surfaces (popover, panel, status pill, etc).
 */
export function mountScanline(
    host: Pick<OverlayHost, 'root'>,
    fieldRect: DOMRect,
): ScanlineHandle {
    const root = host.root
    const doc = root.ownerDocument
    const wrapper = doc.createElement('div')
    wrapper.setAttribute('data-grammarforge-scanline', '')
    wrapper.setAttribute('aria-hidden', 'true')
    positionWrapper(wrapper, fieldRect)
    const scanline = doc.createElement('div')
    scanline.className = 'gf-scanline'
    wrapper.appendChild(scanline)
    root.appendChild(wrapper)
    return {
        isMounted: () => wrapper.isConnected,
        update: (r) => {
            if (wrapper.isConnected) positionWrapper(wrapper, r)
        },
        remove: () => {
            if (wrapper.isConnected) wrapper.remove()
        },
    }
}

/**
 * Detach a scan-line. Equivalent to `handle.remove()`; exported as a
 * free function so callers that stash the handle on a slot can detach
 * without first dereferencing it. Idempotent.
 */
export function removeScanline(handle: ScanlineHandle): void {
    handle.remove()
}

function positionWrapper(wrapper: HTMLElement, r: DOMRect): void {
    // The wrapper's box is the field's rect. The scan-line child fills it
    // horizontally (CSS `left: 0; right: 0;`) and the keyframe's `top: -2%`
    // / `top: 102%` resolve against the wrapper's height. `z-index: 7`
    // keeps the sweep under the design-system z-stack (orb + popover +
    // panel all sit above 8) but above the host's `z-index: 2147483647`
    // setting? No — the host is the stacking context owner; the wrapper's
    // z-index is local to the host's children, so 7 is the relative
    // stacking. The status orb + popover + panel use inline `z-index: ...`
    // (status via transform-based position with their own z) and end up
    // above 7 by ordering + their own classes. Pointer events off — the
    // scan-line is purely visual, never an interaction target.
    wrapper.style.cssText =
        `position: fixed; top: ${r.top}px; left: ${r.left}px; ` +
        `width: ${r.width}px; height: ${r.height}px; ` +
        `pointer-events: none; z-index: 7;`
}
