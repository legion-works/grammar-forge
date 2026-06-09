// @vitest-environment jsdom
// Per-field lifecycle: bind input/blur + a per-field debouncer to an
// editable element, and release them deterministically when the field
// leaves the DOM (chatty SPAs churn the field set — without explicit
// detach, the input/blur listeners + closures (capturing `el`) leak
// until full content-script teardown, and the popup field count only
// ever increases).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFieldAttachment, type FieldAttachmentOptions } from '@/input/attachment'

interface CountBox {
    count: number
}

function mkOptions(overrides: Partial<FieldAttachmentOptions> = {}): FieldAttachmentOptions {
    return {
        realtimeDelayMs: 200,
        onRunCheck: vi.fn<(el: HTMLElement, text: string) => Promise<void>>(),
        onBlur: vi.fn<() => void>(),
        ...overrides,
    }
}

function mkCount(initial: number): { box: CountBox; reader: () => number; dec: () => void } {
    const box: CountBox = { count: initial }
    return {
        box,
        reader: () => box.count,
        dec: () => {
            if (box.count > 0) box.count -= 1
        },
    }
}

describe('createFieldAttachment', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
        document.body.innerHTML = ''
    })

    it('attach exposes rerun + debouncedRun on the returned handle', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const att = createFieldAttachment(
            ta,
            mkOptions(),
            () => 0,
            () => {},
        )
        expect(typeof att.rerun).toBe('function')
        expect(typeof att.debouncedRun).toBe('function')
        expect(att.isDetached()).toBe(false)
        att.detach()
    })

    it('detach() releases the input + blur listeners (no further events fire)', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )
        att.detach()

        // After detach, dispatching events must not reach the debouncer
        // (which would call onRunCheck) or the onBlur callback.
        ta.dispatchEvent(new Event('input'))
        ta.dispatchEvent(new Event('blur'))
        vi.advanceTimersByTime(500)
        expect(opts.onRunCheck).not.toHaveBeenCalled()
        expect(opts.onBlur).not.toHaveBeenCalled()
        expect(att.isDetached()).toBe(true)
    })

    it('detach() decrements fieldCount', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const counter = mkCount(2)
        const att = createFieldAttachment(ta, mkOptions(), counter.reader, counter.dec)
        expect(counter.box.count).toBe(2)
        att.detach()
        expect(counter.box.count).toBe(1)
    })

    it('detach() is idempotent — calling twice does not change fieldCount or throw', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const counter = mkCount(1)
        const att = createFieldAttachment(ta, mkOptions(), counter.reader, counter.dec)
        att.detach()
        expect(counter.box.count).toBe(0)
        expect(() => att.detach()).not.toThrow()
        expect(counter.box.count).toBe(0)
    })

    it('detach() destroys any rendered overlay handles (highlight/popover/status)', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const att = createFieldAttachment(
            ta,
            mkOptions(),
            () => 0,
            () => {},
        )
        const highlightDestroy = vi.fn<() => void>()
        const popoverHide = vi.fn<() => void>()
        const statusDestroy = vi.fn<() => void>()
        att.setHandles({ highlightDestroy, popoverHide, statusDestroy })
        att.detach()
        expect(highlightDestroy).toHaveBeenCalledTimes(1)
        expect(popoverHide).toHaveBeenCalledTimes(1)
        expect(statusDestroy).toHaveBeenCalledTimes(1)
    })

    it('a re-render setHandles swap does NOT run the prior highlightDestroy', () => {
        // Regression guard: the highlight layer / native registry is updated
        // IN PLACE on every render, so the prior render's highlightDestroy must
        // NOT fire on a swap — doing so wiped the highlights the new render had
        // just set ("highlights die on the first edit"). The transient pill +
        // popover destroyers DO fire on the swap (they're recreated per render).
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const att = createFieldAttachment(
            ta,
            mkOptions(),
            () => 0,
            () => {},
        )
        const highlightDestroy1 = vi.fn<() => void>()
        const popoverHide1 = vi.fn<() => void>()
        const statusDestroy1 = vi.fn<() => void>()
        att.setHandles({
            highlightDestroy: highlightDestroy1,
            popoverHide: popoverHide1,
            statusDestroy: statusDestroy1,
        })
        // Second render (e.g. after an edit) swaps in fresh handles.
        att.setHandles({
            highlightDestroy: vi.fn<() => void>(),
            popoverHide: vi.fn<() => void>(),
            statusDestroy: vi.fn<() => void>(),
        })
        // The prior highlight was NOT destroyed (persistent, updated in place)…
        expect(highlightDestroy1).not.toHaveBeenCalled()
        // …but the prior transient pill + popover WERE torn down on the swap.
        expect(popoverHide1).toHaveBeenCalledTimes(1)
        expect(statusDestroy1).toHaveBeenCalledTimes(1)
        att.detach()
    })

    it('detach still clears the highlight even after re-render swaps dropped it', () => {
        // The highlightDestroy is carried forward across swaps so detach can
        // still clear the persistent highlight, even when a later render didn't
        // re-supply one.
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const att = createFieldAttachment(
            ta,
            mkOptions(),
            () => 0,
            () => {},
        )
        const highlightDestroy = vi.fn<() => void>()
        att.setHandles({ highlightDestroy })
        // A later render supplies only a status handle (no highlightDestroy).
        att.setHandles({ statusDestroy: vi.fn<() => void>() })
        att.detach()
        // The original highlight destroyer was carried forward and fired once.
        expect(highlightDestroy).toHaveBeenCalledTimes(1)
    })

    it('clearHandles() tears down everything (incl. highlight) without detaching', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const att = createFieldAttachment(
            ta,
            mkOptions(),
            () => 0,
            () => {},
        )
        const highlightDestroy = vi.fn<() => void>()
        const popoverHide = vi.fn<() => void>()
        const statusDestroy = vi.fn<() => void>()
        att.setHandles({ highlightDestroy, popoverHide, statusDestroy })
        att.clearHandles()
        expect(highlightDestroy).toHaveBeenCalledTimes(1)
        expect(popoverHide).toHaveBeenCalledTimes(1)
        expect(statusDestroy).toHaveBeenCalledTimes(1)
        // Not detached — the attachment is still live.
        expect(att.isDetached()).toBe(false)
        att.detach()
    })

    it('the debounced run reads text at FIRE time, not at call time (Fix 2)', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'hello'
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )

        att.debouncedRun()
        // The onRunCheck must NOT have fired synchronously — the
        // attachment is a debouncer, not a direct call.
        expect(opts.onRunCheck).not.toHaveBeenCalled()
        // Mutate the value AFTER the keystroke but BEFORE the debounce
        // fires; the implementation must read the fresh text.
        ta.value = 'hello world'
        await vi.advanceTimersByTimeAsync(250)
        expect(opts.onRunCheck).toHaveBeenCalledTimes(1)
        const call = (opts.onRunCheck as ReturnType<typeof vi.fn>).mock.calls[0] as
            | [HTMLElement, string]
            | undefined
        expect(call?.[1]).toBe('hello world')
        att.detach()
    })

    it('the debouncer coalesces rapid calls into a single check (Fix 2)', async () => {
        const ta = document.createElement('textarea')
        ta.value = 'a'
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )

        att.debouncedRun()
        att.debouncedRun()
        att.debouncedRun()
        await vi.advanceTimersByTimeAsync(250)
        expect(opts.onRunCheck).toHaveBeenCalledTimes(1)
        att.detach()
    })

    it('input events from the field trigger a debounced check end-to-end', () => {
        const ta = document.createElement('textarea')
        ta.value = 'a'
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )

        ta.value = 'ab'
        ta.dispatchEvent(new Event('input'))
        ta.value = 'abc'
        ta.dispatchEvent(new Event('input'))
        vi.advanceTimersByTime(250)
        expect(opts.onRunCheck).toHaveBeenCalledTimes(1)
        const call = (opts.onRunCheck as ReturnType<typeof vi.fn>).mock.calls[0] as
            | [HTMLElement, string]
            | undefined
        expect(call?.[1]).toBe('abc')
        att.detach()
    })

    it('onInputEvent gate returning false suppresses the debounced check', () => {
        const ta = document.createElement('textarea')
        ta.value = 'a'
        document.body.appendChild(ta)
        const opts = mkOptions({ onInputEvent: vi.fn<(t: string) => boolean>(() => false) })
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )
        ta.value = 'ab'
        ta.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }))
        vi.advanceTimersByTime(500)
        expect(opts.onRunCheck).not.toHaveBeenCalled()
        att.detach()
    })

    it('onInputEvent gate receives the event inputType and gates per type', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        // Allow typing, block paste.
        const gate = vi.fn<(t: string) => boolean>((t) => t !== 'insertFromPaste')
        const opts = mkOptions({ onInputEvent: gate })
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )
        ta.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste' }))
        ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText' }))
        vi.advanceTimersByTime(500)
        expect(gate.mock.calls.map((c) => c[0])).toEqual(['insertFromPaste', 'insertText'])
        // Only the allowed (typing) event scheduled a check.
        expect(opts.onRunCheck).toHaveBeenCalledTimes(1)
        att.detach()
    })

    it('cancelPending() drops a scheduled debounced check', () => {
        const ta = document.createElement('textarea')
        ta.value = 'a'
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )
        att.debouncedRun()
        att.cancelPending()
        vi.advanceTimersByTime(500)
        expect(opts.onRunCheck).not.toHaveBeenCalled()
        att.detach()
    })

    it('blur event calls onBlur synchronously', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const opts = mkOptions()
        const att = createFieldAttachment(
            ta,
            opts,
            () => 0,
            () => {},
        )

        ta.dispatchEvent(new Event('blur'))
        expect(opts.onBlur).toHaveBeenCalledTimes(1)
        att.detach()
    })

    it('after detach, input events do NOT decrement the counter a second time', () => {
        const ta = document.createElement('textarea')
        document.body.appendChild(ta)
        const counter = mkCount(1)
        const att = createFieldAttachment(ta, mkOptions(), counter.reader, counter.dec)
        att.detach()
        expect(counter.box.count).toBe(0)
        // dispatch after detach; the input handler bails immediately.
        ta.dispatchEvent(new Event('input'))
        vi.advanceTimersByTime(500)
        expect(counter.box.count).toBe(0)
    })
})
