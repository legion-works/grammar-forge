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
})
