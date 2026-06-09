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
        createFieldObserver({ root: document, onFieldDiscovered, schedule, cancel })
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

    it('deduplicates — a field is only reported once across adds', async () => {
        const cb = vi.fn<() => void>()
        const { observe, flush } = make(cb)
        const stop = observe()

        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        await flush()
        expect(cb).toHaveBeenCalledTimes(1)

        ta.remove()
        document.body.appendChild(ta)
        await flush()
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
