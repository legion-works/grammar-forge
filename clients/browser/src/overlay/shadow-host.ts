// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Manual shadow-DOM host. We intentionally do NOT use WXT's createShadowRootUi
// helper, which pulls in a React renderer and would blow the MV3 startup
// budget. A bare attachShadow({mode:'open'}) on a host element appended
// directly to document.body gives the overlay an isolated style scope and
// a `position: fixed` containing block that the page cannot break with
// stray `transform`/`filter` ancestors.
//
// The host is the OWNER of the shadow root. destroy() must be complete:
// it dismisses any open popover (removing its document-level outside-click
// listener and clearing its mount-delay timer) BEFORE removing the host
// element. This is the only path the content script uses to tear the
// overlay down (ctx.onInvalidated), so any leak here would persist for
// the lifetime of the page.
import { dismissPopoversIn } from '@/overlay/popover'
import { OVERLAY_CSS } from '@/overlay/styles'

export interface OverlayHost {
    /** The open shadow root styles are injected into and components render into. */
    root: ShadowRoot
    /** The host element on document.body. Exposed for tests + positioning. */
    host: HTMLDivElement
    /**
     * Tear down: dismiss every popover (releasing their document listeners
     * + timers), remove the host from the DOM. Idempotent.
     */
    destroy: () => void
    /** Whether destroy() has already been called. */
    isDestroyed: () => boolean
}

/**
 * Create a shadow-DOM overlay host. A fresh host is created on each call —
 * the content script is expected to keep one host per content-script
 * lifetime and call `destroy()` from `ctx.onInvalidated`.
 */
export function createOverlayHost(doc: Document = document): OverlayHost {
    const host = doc.createElement('div')
    host.setAttribute('data-grammarforge-overlay', '')
    // CSS-string form keeps style.cssText deterministic for tests + avoids
    // accidental `transform`/`filter` ancestors that would re-parent fixed
    // children away from the viewport.
    host.style.cssText =
        'position: absolute; top: 0; left: 0; pointer-events: none; z-index: 2147483647;'
    // open mode is required so consumers (tests, future Floating-UI
    // integrations) can introspect the rendered DOM. close mode would
    // also work, but it makes E2E test introspection much harder.
    const root = host.attachShadow({ mode: 'open' })
    const style = doc.createElement('style')
    style.textContent = OVERLAY_CSS
    root.appendChild(style)
    doc.body.appendChild(host)

    let destroyed = false
    return {
        host,
        root,
        isDestroyed: () => destroyed,
        destroy: () => {
            if (destroyed) return
            destroyed = true
            // 1. dismiss any open popover FIRST — this removes its
            //    document-level mousedown listener and clears its
            //    mount-delay setTimeout, both of which would leak past
            //    the page lifetime if we removed the host first.
            dismissPopoversIn(root)
            // 2. remove any underline + status-pill nodes we may have
            //    rendered. We don't have a registry of those, but the
            //    popover is the only thing that installs document-level
            //    listeners; the rest are pure shadow-root children that
            //    go away with the host.
            // 3. finally, remove the host element.
            host.remove()
        },
    }
}
