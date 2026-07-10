// Unified outside-click dismiss helper for all transient GrammarForge
// surfaces (Goals, synonyms, correction card, review panel).
//
// ROOT CAUSE of the repeated live failure (rounds 3–5):
//   All surfaces used `doc.addEventListener('pointerdown'/'mousedown', ...,
//   {capture:true})` where `doc = root.ownerDocument`. In a content-script
//   context `doc` IS the page document — but some host pages (GitHub,
//   Fastmail) install their own `window.addEventListener('pointerdown', ...,
//   {capture:true})` handlers that call `event.stopPropagation()`. A
//   stopPropagation in a window capture listener fires BEFORE any document
//   capture listener, so our `doc` listener never fires.
//
// FIX: attach on `window` in capture phase. `window` capture fires FIRST,
// before any page handler can stop propagation. composedPath() is still
// shadow-DOM aware (it returns the full path including shadow-root internals
// when called synchronously in the handler).
//
// INSTRUMENT: when GF_DEBUG is set, every dismiss event logs:
//   [gf-dismiss] fired | composedPath length | contained? | surface class
// so if a live failure recurs the user's next test is decisive.
//
// UNIFIED: one factory, one pattern, all surfaces. Per-surface ad-hoc
// listeners are replaced by `installOutsideDismiss(view, isInside, onDismiss)`.

import { debugLog } from '@/lib/debug-log'

export interface OutsideDismissHandle {
    /** Remove the listener immediately (call in destroy()). */
    remove: () => void
}

/**
 * Install a capture-phase `pointerdown` listener on `view` (window) that
 * calls `onDismiss()` when the event's composedPath does NOT include any
 * element for which `isInside(el)` returns true.
 *
 * Armed after a `setTimeout(0)` so the click that opened the surface
 * doesn't immediately dismiss it. The returned handle's `remove()` cancels
 * the arm timer and removes the listener.
 *
 * @param view      The window to attach to (root.ownerDocument.defaultView).
 * @param isInside  Return true for any element that should NOT trigger dismiss.
 * @param onDismiss Called when an outside pointerdown is detected.
 * @param label     Short surface label for debug logging (e.g. 'goals').
 */
export function installOutsideDismiss(
    view: Window,
    isInside: (el: Element) => boolean,
    onDismiss: () => void,
    label: string,
): OutsideDismissHandle {
    let installed = false

    const onPointerDown = (event: PointerEvent): void => {
        if (!installed) return
        const path = event.composedPath()
        for (const node of path) {
            if (node instanceof Element && isInside(node)) {
                debugLog('dismiss', `${label}: inside — kept open`, {
                    pathLen: path.length,
                    node: node.className,
                })
                return
            }
        }
        debugLog('dismiss', `${label}: outside — dismissing`, {
            pathLen: path.length,
            target: (event.target as Element | null)?.className ?? '?',
        })
        // Self-remove BEFORE calling onDismiss so the listener can't fire
        // again if onDismiss synchronously triggers another pointerdown
        // (e.g. a re-render that re-opens the surface). This also prevents
        // the "fires 15+ times" repeat: without self-removal, every
        // subsequent outside click re-fires onDismiss on a stale surface.
        view.removeEventListener('pointerdown', onPointerDown, { capture: true })
        installed = false
        onDismiss()
    }

    const armTimer = view.setTimeout(() => {
        installed = true
        // window capture: fires before any page handler can stopPropagation.
        view.addEventListener('pointerdown', onPointerDown, { capture: true })
    }, 0)

    return {
        remove: () => {
            view.clearTimeout(armTimer)
            if (installed) {
                view.removeEventListener('pointerdown', onPointerDown, { capture: true })
                installed = false
            }
        },
    }
}

export interface EscapeCaptureHandle {
    /** Remove the listener immediately (call in destroy()). */
    remove: () => void
}

/**
 * P1-7: Esc-to-dismiss, window-capture variant — the same fix
 * installOutsideDismiss already applies to outside-click. goals.ts and
 * synonyms.ts used to attach `doc.addEventListener('keydown', ...)` on the
 * DOCUMENT bubble phase; a host page that installs its own
 * `window.addEventListener('keydown', ..., {capture:true})` +
 * stopPropagation() (the same pattern documented above for pointerdown)
 * fires BEFORE that document-bubble listener ever sees the event, so Esc
 * silently does nothing on those hosts. Attaching on `window` in the
 * capture phase fires FIRST, same as the outside-click fix.
 *
 * No arm-delay is needed here (unlike installOutsideDismiss) — there is no
 * "the keypress that opened the surface" race to guard against.
 */
export function installEscapeCapture(
    view: Window,
    onEscape: () => void,
    label: string,
): EscapeCaptureHandle {
    const onKeydown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return
        debugLog('dismiss', `${label}: escape (window capture)`)
        event.stopPropagation()
        onEscape()
    }
    // window capture: fires before any page handler can stopPropagation.
    view.addEventListener('keydown', onKeydown, { capture: true })
    return {
        remove: () => view.removeEventListener('keydown', onKeydown, { capture: true }),
    }
}
