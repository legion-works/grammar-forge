import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncer } from '@/input/debounce'

describe('createDebouncer (trailing edge)', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('does not call the fn before the wait elapses', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        expect(fn).not.toHaveBeenCalled()
        vi.advanceTimersByTime(199)
        expect(fn).not.toHaveBeenCalled()
    })

    it('calls the fn once after the wait (trailing edge)', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        vi.advanceTimersByTime(200)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith('a')
    })

    it('coalesces rapid calls and passes the latest argument', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        debounced('b')
        debounced('c')
        vi.advanceTimersByTime(199)
        expect(fn).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith('c')
    })

    it('restarts the timer on each call (trailing-only, no leading)', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        vi.advanceTimersByTime(150)
        debounced('b')
        vi.advanceTimersByTime(150)
        expect(fn).not.toHaveBeenCalled()
        vi.advanceTimersByTime(50)
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith('b')
    })

    it('cancel() drops a pending call', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        debounced.cancel()
        vi.advanceTimersByTime(500)
        expect(fn).not.toHaveBeenCalled()
    })

    it('flush() invokes the pending call immediately with the latest args', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced('a')
        debounced('b')
        debounced.flush()
        expect(fn).toHaveBeenCalledTimes(1)
        expect(fn).toHaveBeenCalledWith('b')
        vi.advanceTimersByTime(500)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('flush() is a no-op when nothing is pending', () => {
        const fn = vi.fn<(arg: string) => void>()
        const debounced = createDebouncer(fn, 200)
        debounced.flush()
        expect(fn).not.toHaveBeenCalled()
    })
})
