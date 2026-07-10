import type { SignalEvent } from '@/api/client'

export type SignalSender = (events: SignalEvent[]) => Promise<unknown>
/** Fire-and-forget sender for the final (page-unloading) flush — never
 *  awaited, never retried (there is no "next flush" once the page is gone). */
export type SignalFinalSender = (events: SignalEvent[]) => void

export interface SignalQueueOptions {
    send: SignalSender
    /** Used by flushFinal() instead of `send` when provided (e.g. a
     *  keepalive-fetch/sendBeacon variant safe to call from pagehide). Falls
     *  back to `send` (fire-and-forget) when omitted. */
    sendFinal?: SignalFinalSender
    debounceMs?: number
    schedule?: (fn: () => void, ms: number) => unknown
    cancel?: (handle: unknown) => void
    /** Cap on buffered events retained across a failed send / requeue.
     *  Oldest events are dropped first once the cap is exceeded — telemetry
     *  is best-effort, but an unbounded buffer on a persistently-failing
     *  bridge would leak memory for the life of the tab. */
    maxBufferSize?: number
}

export interface SignalQueue {
    enqueue(event: SignalEvent): void
    flush(): Promise<void>
    /** Synchronous, best-effort final flush for pagehide/visibilitychange —
     *  drains the buffer through `sendFinal` (or `send` if absent) without
     *  awaiting or requeuing on failure. */
    flushFinal(): void
}

const defaultSchedule = (fn: () => void, ms: number): unknown => setTimeout(fn, ms)
const defaultCancel = (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const DEFAULT_MAX_BUFFER_SIZE = 200

export function createSignalQueue(opts: SignalQueueOptions): SignalQueue {
    const send = opts.send
    const sendFinal = opts.sendFinal
    const debounceMs = opts.debounceMs ?? 1000
    const schedule = opts.schedule ?? defaultSchedule
    const cancel = opts.cancel ?? defaultCancel
    const maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE

    let buffer: SignalEvent[] = []
    let timer: unknown = null

    const clearTimer = (): void => {
        if (timer !== null) {
            cancel(timer)
            timer = null
        }
    }

    const capBuffer = (): void => {
        if (buffer.length > maxBufferSize) {
            // Drop-oldest: keep the most recent `maxBufferSize` events.
            buffer = buffer.slice(buffer.length - maxBufferSize)
        }
    }

    /** Put a failed batch back at the FRONT of the buffer (oldest-first),
     *  ahead of anything enqueued during the failed send, then re-cap. */
    const requeue = (events: SignalEvent[]): void => {
        buffer = [...events, ...buffer]
        capBuffer()
    }

    const dispatch = async (events: SignalEvent[]): Promise<void> => {
        try {
            await send(events)
        } catch (e) {
            // A failed send must never break the UX, but telemetry loss on a
            // transient bridge outage is also a real cost — requeue for the
            // next debounce/flush instead of dropping the batch.
            // oxlint-disable-next-line no-console
            console.warn('signal queue: send failed, requeuing', e)
            requeue(events)
        }
    }

    return {
        enqueue(event: SignalEvent): void {
            buffer.push(event)
            capBuffer()
            clearTimer()
            timer = schedule(() => {
                timer = null
                const batch = buffer
                buffer = []
                void dispatch(batch)
            }, debounceMs)
        },
        async flush(): Promise<void> {
            clearTimer()
            if (buffer.length === 0) return
            const batch = buffer
            buffer = []
            await dispatch(batch)
        },
        flushFinal(): void {
            clearTimer()
            if (buffer.length === 0) return
            const batch = buffer
            buffer = []
            const finalSend = sendFinal ?? ((events: SignalEvent[]) => void send(events).catch(() => {}))
            try {
                finalSend(batch)
            } catch {
                // Best-effort: the page is going away, nothing more we can do.
            }
        },
    }
}
