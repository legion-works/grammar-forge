import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSignalQueue } from '@/signal/queue'
import type { SignalEvent } from '@/api/client'

afterEach(() => {
    vi.useRealTimers()
})

describe('createSignalQueue', () => {
    it('batches multiple enqueues within the debounce window into one send call', async () => {
        vi.useFakeTimers()
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockResolvedValue(undefined)
        const q = createSignalQueue({ send, debounceMs: 1000 })

        q.enqueue({ action: 'accepted', source: 'browser' })
        q.enqueue({ action: 'rejected', category: 'spelling', source: 'browser' })
        q.enqueue({ action: 'ignored', category: 'grammar', source: 'browser' })

        expect(send).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(1000)
        await Promise.resolve()

        expect(send).toHaveBeenCalledTimes(1)
        const batch = send.mock.calls[0]![0]!
        expect(batch).toHaveLength(3)
        expect(batch[0]).toEqual({ action: 'accepted', source: 'browser' })
        expect(batch[1]).toEqual({ action: 'rejected', category: 'spelling', source: 'browser' })
        expect(batch[2]).toEqual({ action: 'ignored', category: 'grammar', source: 'browser' })
    })

    it('flush() sends buffered events immediately and clears the buffer', async () => {
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockResolvedValue(undefined)
        const q = createSignalQueue({ send, debounceMs: 1000 })

        q.enqueue({ action: 'accepted', category: 'style', source: 'browser' })
        await q.flush()

        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]![0]).toEqual([
            { action: 'accepted', category: 'style', source: 'browser' },
        ])

        await q.flush()
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('swallows send errors and does not throw out of enqueue or flush', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockRejectedValue(new Error('network down'))
        const q = createSignalQueue({ send, debounceMs: 1000 })

        expect(() => q.enqueue({ action: 'accepted', source: 'browser' })).not.toThrow()
        await expect(q.flush()).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalled()
    })

    it('P0-2: requeues a failed batch instead of dropping it, so the next flush retries it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValue(undefined)
        const q = createSignalQueue({ send, debounceMs: 1000 })

        q.enqueue({ action: 'accepted', category: 'spelling', source: 'browser' })
        await q.flush()
        expect(send).toHaveBeenCalledTimes(1)

        // The failed batch must not be lost — it should go out again on the
        // next flush, ahead of anything enqueued after the failure.
        q.enqueue({ action: 'rejected', category: 'grammar', source: 'browser' })
        await q.flush()

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1]![0]).toEqual([
            { action: 'accepted', category: 'spelling', source: 'browser' },
            { action: 'rejected', category: 'grammar', source: 'browser' },
        ])
    })

    it('P0-2: caps the requeue buffer and drops the OLDEST events first', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValue(undefined)
        const q = createSignalQueue({ send, debounceMs: 1000, maxBufferSize: 2 })

        q.enqueue({ id: 1, action: 'accepted', source: 'browser' })
        q.enqueue({ id: 2, action: 'accepted', source: 'browser' })
        q.enqueue({ id: 3, action: 'accepted', source: 'browser' })
        await q.flush()
        expect(send).toHaveBeenCalledTimes(1)

        await q.flush()
        expect(send).toHaveBeenCalledTimes(2)
        // Cap is 2 — the oldest (id 1) was dropped, ids 2 and 3 survive.
        expect(send.mock.calls[1]![0]).toEqual([
            { id: 2, action: 'accepted', source: 'browser' },
            { id: 3, action: 'accepted', source: 'browser' },
        ])
    })

    it('P0-2: flushFinal() drains the buffer synchronously through sendFinal (for pagehide)', () => {
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockResolvedValue(undefined)
        const sendFinal = vi.fn<(events: SignalEvent[]) => void>()
        const q = createSignalQueue({ send, sendFinal, debounceMs: 1000 })

        q.enqueue({ action: 'accepted', source: 'browser' })
        q.flushFinal()

        expect(sendFinal).toHaveBeenCalledTimes(1)
        expect(sendFinal.mock.calls[0]![0]).toEqual([{ action: 'accepted', source: 'browser' }])
        expect(send).not.toHaveBeenCalled()

        // Buffer is drained — a second flushFinal with nothing queued is a no-op.
        q.flushFinal()
        expect(sendFinal).toHaveBeenCalledTimes(1)
    })

    it('P0-2: flushFinal() falls back to fire-and-forget `send` when no sendFinal is provided', () => {
        const send = vi
            .fn<(events: SignalEvent[]) => Promise<unknown>>()
            .mockResolvedValue(undefined)
        const q = createSignalQueue({ send, debounceMs: 1000 })

        q.enqueue({ action: 'accepted', source: 'browser' })
        expect(() => q.flushFinal()).not.toThrow()

        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0]![0]).toEqual([{ action: 'accepted', source: 'browser' }])
    })
})
