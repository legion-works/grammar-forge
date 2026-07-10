// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// MutationObserver-based field discoverer. Does an initial sweep of `root`
// (and its descendants), then observes childList+subtree and the editable-
// status attributes (contenteditable, role, g_editable) for added/removed
// nodes. Coalesces a single rAF tick between mutation batches and the
// callback so we never call onFieldDiscovered more than once per element
// (WeakSet dedup) and never synchronously from inside the observer.

import { isEditableElement } from '@/input/detector'

/** The attributes that can flip a non-editable element into an editable one
 *  — or, since Feature 1 (sensitive-field exclusion), flip an already-
 *  editable one OUT of eligibility. `type` covers the "show password"
 *  toggle case: a site may flip `<input type="password">` to
 *  `type="text"` (reveal) and back to `type="password"` (hide); the
 *  reveal direction must not attach (the sensitive gate re-checks and
 *  still may reject on autocomplete), and the re-hide direction MUST
 *  detach an already-attached field immediately — the whole point of the
 *  exclusion is that a password never has underlines/orb/checking, even
 *  transiently while flipped to text and back. */
const EDITABLE_ATTRS: ReadonlyArray<string> = ['contenteditable', 'role', 'g_editable', 'type']

export interface FieldObserverOptions {
    root: ParentNode
    onFieldDiscovered: (el: HTMLElement) => void
    /**
     * Fires when a previously-discovered field is removed from the DOM.
     * Chatty SPAs (Gmail/Notion/Discord) add+remove editor fields constantly;
     * the content orchestrator needs the detach event to release per-field
     * listeners (input/blur), destroy overlay handles, and decrement the
     * popup field count. Optional — older callers that don't care about
     * detach can omit it.
     */
    onFieldDetached?: (el: HTMLElement) => void
    /** Injectable for tests; defaults to window.requestAnimationFrame. */
    schedule?: (cb: () => void) => number
    /** Injectable for tests; defaults to window.cancelAnimationFrame. */
    cancel?: (handle: number) => void
    /** Injectable for tests; defaults to window.MutationObserver. */
    createObserver?: (cb: MutationCallback) => MutationObserver
    /** Override the editable-element predicate (default: isEditableElement). */
    isEditable?: (el: Element) => el is HTMLElement
}

/**
 * Start watching `root` for editable text fields. The returned function
 * stops the observer and cancels any pending rAF.
 */
export function createFieldObserver(opts: FieldObserverOptions): () => void {
    const {
        root,
        onFieldDiscovered,
        onFieldDetached,
        schedule = defaultSchedule,
        cancel = defaultCancel,
        createObserver = defaultObserver,
        isEditable = defaultIsEditable,
    } = opts

    // `seen` is the single source of truth for "we know about this field".
    // `reported` tracks elements we have already announced via
    // onFieldDiscovered; `detached` is a one-shot guard so the same node
    // doesn't get the onFieldDetached callback twice (e.g. when the MO
    // coalesces the removal of an outer container and one of its children
    // across two microtasks). Both are WeakSets — they pin no memory.
    const seen = new WeakSet<Element>()
    const reported = new WeakSet<Element>()
    const detached = new WeakSet<Element>()
    const pending = new Set<Element>()
    const detachPending = new Set<Element>()
    let rafHandle: number | null = null

    const consider = (el: Element | null | undefined): void => {
        if (!el || seen.has(el)) return
        if (isEditable(el)) {
            seen.add(el)
            pending.add(el)
        }
    }

    const drain = (): void => {
        rafHandle = null
        // Iterate a snapshot — the callback may add more elements to `pending`
        // (e.g. an applyFix that mutates the DOM) and we want to flush the
        // current batch before processing new ones.
        const batch = Array.from(pending)
        pending.clear()
        for (const el of batch) {
            onFieldDiscovered(el as HTMLElement)
            reported.add(el)
        }
        // Detach events fire in the same rAF tick so a remove+add of the
        // same node in one frame is reported atomically (added first, then
        // removed).
        const detaches = Array.from(detachPending)
        detachPending.clear()
        for (const el of detaches) {
            if (detached.has(el)) continue
            detached.add(el)
            onFieldDetached?.(el as HTMLElement)
        }
    }

    const requestDrain = (): void => {
        if (rafHandle != null) return
        rafHandle = schedule(drain)
    }

    // Initial sweep. Index-based queue — no shift() — so a 10k-node root
    // scans in O(n) instead of O(n²). (The original `.shift()` + `.push(...spread)`
    // pattern re-indexed the whole queue on every step.)
    const initialQueue: Element[] = [root as Element]
    for (let i = 0; i < initialQueue.length; i++) {
        const n = initialQueue[i]!
        consider(n)
        if (n instanceof HTMLElement || n instanceof Document) {
            const kids = n.children
            for (let k = 0; k < kids.length; k++) {
                initialQueue.push(kids[k] as Element)
            }
        }
    }
    requestDrain()

    const observer = createObserver((mutations) => {
        for (const m of mutations) {
            if (m.type === 'childList') {
                for (const n of m.addedNodes) {
                    if (n instanceof Element) {
                        const stack: Element[] = [n]
                        while (stack.length) {
                            const cur = stack.pop()!
                            consider(cur)
                            const kids = cur.children
                            for (let k = 0; k < kids.length; k++) {
                                stack.push(kids[k] as Element)
                            }
                        }
                    }
                }
                // A removed field may still be in `seen` (and possibly
                // `reported`); we surface it via onFieldDetached so the
                // caller can release its listeners + state. We also drop it
                // from `seen` so a re-insertion later is treated as a brand
                // new field (a fresh onFieldDiscovered is the right call —
                // the OLD onFieldDetached already cleaned up the old state).
                //
                // CRITICAL: removedNodes only contains the TOP-LEVEL removed
                // nodes, not their descendants. A discovered field is often a
                // DESCENDANT of the removed node (e.g. a modal/dialog closes by
                // removing its container, with the editable field nested
                // inside). So we must walk each removed node's subtree — exactly
                // mirroring the addedNodes walk above — and detach every
                // discovered field within it. Without this the overlay pill is
                // orphaned when the field's container is removed.
                for (const n of m.removedNodes) {
                    if (!(n instanceof Element)) continue
                    const stack: Element[] = [n]
                    while (stack.length) {
                        const cur = stack.pop()!
                        if (reported.has(cur)) {
                            seen.delete(cur)
                            reported.delete(cur)
                            detachPending.add(cur)
                        } else if (seen.has(cur)) {
                            // Discovered this frame but not yet announced
                            // (still in `pending`): it left before drain, so
                            // cancel the pending discovery instead of announcing
                            // a field that is already gone.
                            seen.delete(cur)
                            pending.delete(cur)
                        }
                        const kids = cur.children
                        for (let k = 0; k < kids.length; k++) {
                            stack.push(kids[k] as Element)
                        }
                    }
                }
            } else if (m.type === 'attributes' && m.target instanceof Element) {
                const el = m.target
                if (reported.has(el)) {
                    // Already announced via onFieldDiscovered. Most attribute
                    // flips leave it eligible (no-op here — `consider` would
                    // no-op anyway since `seen` already has it). But some
                    // flips make it INELIGIBLE (the password-reveal-toggle
                    // case: `type` flips text→password, or `contenteditable`
                    // flips to "false"): the field must detach immediately,
                    // not linger until it happens to leave the DOM. Mirrors
                    // the removedNodes handling below — drop it from
                    // seen/reported and queue the detach callback.
                    if (!isEditable(el)) {
                        seen.delete(el)
                        reported.delete(el)
                        detachPending.add(el)
                    }
                } else if (seen.has(el)) {
                    // Discovered this frame but not yet announced (still in
                    // `pending`): if the flip made it ineligible before we
                    // ever reported it, cancel the pending discovery instead
                    // of announcing a field that's already unfit.
                    if (!isEditable(el)) {
                        seen.delete(el)
                        pending.delete(el)
                    }
                } else {
                    consider(el)
                }
            }
        }
        if (pending.size || detachPending.size) requestDrain()
    })

    observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: EDITABLE_ATTRS as string[],
    })

    return () => {
        observer.disconnect()
        if (rafHandle != null) {
            cancel(rafHandle)
            rafHandle = null
        }
    }
}

const defaultIsEditable = (el: Element): el is HTMLElement => isEditableElement(el)

const defaultSchedule = (cb: () => void): number => requestAnimationFrame(cb)

const defaultCancel = (h: number): void => {
    cancelAnimationFrame(h)
}

const defaultObserver = (cb: MutationCallback): MutationObserver => new MutationObserver(cb)
