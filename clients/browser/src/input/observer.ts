// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// MutationObserver-based field discoverer. Does an initial sweep of `root`
// (and its descendants), then observes childList+subtree and the editable-
// status attributes (contenteditable, role, g_editable) for added/removed
// nodes. Coalesces a single rAF tick between mutation batches and the
// callback so we never call onFieldDiscovered more than once per element
// (WeakSet dedup) and never synchronously from inside the observer.

import { isEditableElement } from '@/input/detector'

/** The attributes that can flip a non-editable element into an editable one. */
const EDITABLE_ATTRS: ReadonlyArray<string> = ['contenteditable', 'role', 'g_editable']

export interface FieldObserverOptions {
    root: ParentNode
    onFieldDiscovered: (el: HTMLElement) => void
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
        schedule = defaultSchedule,
        cancel = defaultCancel,
        createObserver = defaultObserver,
        isEditable = defaultIsEditable,
    } = opts

    const seen = new WeakSet<Element>()
    const pending = new Set<Element>()
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
        for (const el of batch) onFieldDiscovered(el as HTMLElement)
    }

    const requestDrain = (): void => {
        if (rafHandle != null) return
        rafHandle = schedule(drain)
    }

    // Initial sweep
    const initialQueue: Element[] = [root as Element]
    while (initialQueue.length) {
        const n = initialQueue.shift()!
        consider(n)
        if (n instanceof HTMLElement || n instanceof Document) {
            initialQueue.push(...Array.from(n.children))
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
                            stack.push(...Array.from(cur.children))
                        }
                    }
                }
            } else if (m.type === 'attributes' && m.target instanceof Element) {
                consider(m.target)
            }
        }
        if (pending.size) requestDrain()
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
