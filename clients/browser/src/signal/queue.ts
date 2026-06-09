import type { SignalEvent } from '@/api/client'

export type SignalSender = (events: SignalEvent[]) => Promise<unknown>

export interface SignalQueueOptions {
    send: SignalSender
    debounceMs?: number
    schedule?: (fn: () => void, ms: number) => unknown
    cancel?: (handle: unknown) => void
}

export interface SignalQueue {
    enqueue(event: SignalEvent): void
    flush(): Promise<void>
}

const defaultSchedule = (fn: () => void, ms: number): unknown => setTimeout(fn, ms)
const defaultCancel = (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function createSignalQueue(opts: SignalQueueOptions): SignalQueue {
    const send = opts.send
    const debounceMs = opts.debounceMs ?? 1000
    const schedule = opts.schedule ?? defaultSchedule
    const cancel = opts.cancel ?? defaultCancel

    let buffer: SignalEvent[] = []
    let timer: unknown = null

    const clearTimer = (): void => {
        if (timer !== null) {
            cancel(timer)
            timer = null
        }
    }

    const dispatch = async (events: SignalEvent[]): Promise<void> => {
        try {
            await send(events)
        } catch (e) {
            // Best-effort: a failed signal must never break the UX.
            // oxlint-disable-next-line no-console
            console.warn('signal queue: send failed', e)
        }
    }

    return {
        enqueue(event: SignalEvent): void {
            buffer.push(event)
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
    }
}
