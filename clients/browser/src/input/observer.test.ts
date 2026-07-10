// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFieldObserver } from '@/input/observer'
import { isEditableElement } from '@/input/detector'

/**
 * Build an observer wired to a manual rAF drain. Returns a flush() that
 *   1) yields the microtask queue so jsdom delivers pending
 *      MutationObserver callbacks,
 *   2) drains the rAF queue the observer scheduled in response.
 */
const make = (
    onFieldDiscovered: (el: HTMLElement) => void,
    onFieldDetached?: (el: HTMLElement) => void,
): { observe: () => () => void; flush: () => Promise<void> } => {
    let pending: Array<() => void> = []
    const schedule = (cb: () => void): number => {
        pending.push(cb)
        return pending.length
    }
    const cancel = (_h: number): void => {
        // no-op: tests always drain
    }
    const flush = async (): Promise<void> => {
        // jsdom delivers MutationObserver callbacks as a microtask. Three
        // yields is enough for the MO -> callback -> rAF -> drain chain.
        for (let i = 0; i < 3; i++) await Promise.resolve()
        const batch = pending
        pending = []
        for (const cb of batch) cb()
    }
    const observe = (): (() => void) =>
        createFieldObserver({
            root: document,
            onFieldDiscovered,
            schedule,
            cancel,
            onFieldDetached,
        })
    return { observe, flush }
}

describe('createFieldObserver', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('fires onFieldDiscovered for editable fields present at start (initial sweep)', async () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        expect(cb).toHaveBeenCalledWith(ta)
        stop()
    })

    it('fires onFieldDiscovered for fields added after start', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        stop()
    })

    it('does NOT fire for non-editable elements (e.g. <div>)', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()
        const d = document.createElement('div')
        document.body.appendChild(d)
        await flush()
        expect(cb).not.toHaveBeenCalled()
        stop()
    })

    it('deduplicates — a field is only reported once while it stays in the DOM', async () => {
        // (Re-inserting the same node later is a FRESH field — the detach
        // event clears the dedup set so the content orchestrator can rebind
        // listeners against a clean slate.)
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)

        // re-adding the SAME node without a removal in between — the
        // MutationObserver will not even fire (the node was already a
        // child), so the callback count stays at 1.
        expect(cb).toHaveBeenCalledTimes(1)
        stop()
    })

    it('picks up a field that becomes editable (contenteditable added later)', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const d = document.createElement('div')
        document.body.appendChild(d)
        await flush()
        expect(cb).not.toHaveBeenCalled()

        d.setAttribute('contenteditable', 'true')
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        stop()
    })

    it('picks up role="textbox" added to an existing element', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()
        const d = document.createElement('div')
        document.body.appendChild(d)
        await flush()
        expect(cb).not.toHaveBeenCalled()

        d.setAttribute('role', 'textbox')
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        stop()
    })

    it('stop() detaches the MutationObserver and no further callbacks fire', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()
        stop()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()
        expect(cb).not.toHaveBeenCalled()
    })

    it('observes subtree additions (a field nested deep in a shadow-less tree)', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const wrap = document.createElement('section')
        const inner = document.createElement('div')
        const ta = document.createElement('textarea')
        inner.appendChild(ta)
        wrap.appendChild(inner)
        document.body.appendChild(wrap)
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        expect(cb).toHaveBeenCalledWith(ta)
        stop()
    })

    it('respects data-grammarforge-ignore opt-out (never reports it)', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const ta = document.createElement('textarea')
        ta.setAttribute('data-grammarforge-ignore', 'true')
        document.body.appendChild(ta)
        await flush()
        expect(cb).not.toHaveBeenCalled()
        // sanity: the detector agrees
        expect(isEditableElement(ta)).toBe(false)
        stop()
    })

    it('reports only the OUTER host for nested contenteditable elements', async () => {
        // Spec §6: one overlay per editor. <div ce><div ce><p>…</p></div></div>
        // must surface as a single field — the inner div is part of the host.
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const outer = document.createElement('div')
        outer.setAttribute('contenteditable', 'true')
        const inner = document.createElement('div')
        inner.setAttribute('contenteditable', 'true')
        const p = document.createElement('p')
        p.textContent = 'hi'
        inner.appendChild(p)
        outer.appendChild(inner)
        document.body.appendChild(outer)
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)
        expect(cb).toHaveBeenCalledWith(outer)
        stop()
    })
})

describe('createFieldObserver (detached fields on SPA churn)', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('fires onFieldDetached when a discovered field is removed from the DOM', async () => {
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()
        expect(disc).toHaveBeenCalledTimes(1)
        expect(det).not.toHaveBeenCalled()

        ta.remove()
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        expect(det).toHaveBeenCalledWith(ta)
        stop()
    })

    it('does NOT fire onFieldDetached for nodes that were never discovered', async () => {
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()

        // add a non-editable element and then remove it; the observer should
        // stay silent (it never reported the element, so it has nothing to
        // detach).
        const d = document.createElement('div')
        document.body.appendChild(d)
        await flush()
        expect(disc).not.toHaveBeenCalled()

        d.remove()
        await flush()
        expect(det).not.toHaveBeenCalled()
        stop()
    })

    it('does NOT double-fire onFieldDetached when the same field is removed twice', async () => {
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()

        ta.remove()
        await flush()
        expect(det).toHaveBeenCalledTimes(1)

        // re-removing a detached node is a no-op for the second MO microtask
        // (the element is still in the seen set, but the second cycle finds
        // nothing new in removedNodes that the observer hasn't already
        // reported).
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        stop()
    })

    it('fires onFieldDetached when a NON-editable container of the field is removed (modal close)', async () => {
        // WhatsApp/Slack modal case: the field is nested inside a wrapper that
        // is NOT itself editable. Closing the modal removes the WRAPPER, so the
        // field never appears directly in removedNodes — the observer must walk
        // the removed subtree to find the discovered descendant and detach it,
        // or the overlay pill is orphaned after the modal disappears.
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()

        const modal = document.createElement('div')
        const inner = document.createElement('div')
        const ta = document.createElement('textarea')
        inner.appendChild(ta)
        modal.appendChild(inner)
        document.body.appendChild(modal)
        await flush()
        expect(disc).toHaveBeenCalledTimes(1)
        expect(disc).toHaveBeenCalledWith(ta)

        // Remove the OUTER non-editable container (as a modal teardown would).
        modal.remove()
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        expect(det).toHaveBeenCalledWith(ta)
        stop()
    })

    it('reports detach even when the editable ancestor itself is removed', async () => {
        // A nested structure: the OUTER ce div is the field. Removing it must
        // surface one detach event for the outer host.
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()

        const outer = document.createElement('div')
        outer.setAttribute('contenteditable', 'true')
        document.body.appendChild(outer)
        await flush()
        expect(disc).toHaveBeenCalledTimes(1)

        outer.remove()
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        expect(det).toHaveBeenCalledWith(outer)
        stop()
    })
})

describe('createFieldObserver (Feature 1: sensitive-field type mutation)', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('never reports an <input type="password"> present at start', async () => {
        const pw = document.createElement('input')
        pw.type = 'password'
        document.body.appendChild(pw)
        const disc = vi.fn<() => void>()
        const { observe, flush } = make(disc)
        const stop = observe()
        await flush()
        expect(disc).not.toHaveBeenCalled()
        stop()
    })

    it('detaches an already-attached field when its type flips to "password" at runtime (show-password toggle)', async () => {
        const input = document.createElement('input')
        input.type = 'text'
        document.body.appendChild(input)
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()
        await flush()
        expect(disc).toHaveBeenCalledTimes(1)
        expect(det).not.toHaveBeenCalled()

        // Flip to password (e.g. a "hide password" toggle flipping back).
        input.type = 'password'
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        expect(det).toHaveBeenCalledWith(input)
        stop()
    })

    it('does not re-discover a field that flips password → text → password within one drain', async () => {
        const input = document.createElement('input')
        input.type = 'password'
        document.body.appendChild(input)
        const disc = vi.fn<() => void>()
        const det = vi.fn<() => void>()
        const { observe, flush } = make(disc, det)
        const stop = observe()
        await flush()
        expect(disc).not.toHaveBeenCalled()

        // Reveal (password -> text): becomes eligible, should be discovered.
        input.type = 'text'
        await flush()
        expect(disc).toHaveBeenCalledTimes(1)

        // Hide again (text -> password): must detach.
        input.type = 'password'
        await flush()
        expect(det).toHaveBeenCalledTimes(1)
        stop()
    })
})
