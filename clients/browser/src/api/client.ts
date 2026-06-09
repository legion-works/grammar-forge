import { isLocalBridgeUrl } from '@/api/url'
import type { CorrectRequest, CorrectResponse } from '@/api/types'

export interface SignalEvent {
    id?: number
    action: 'accepted' | 'rejected' | 'ignored'
    category?: string
    source: string
}

export class BridgeClient {
    private readonly inFlightCorrect = new Map<string, Promise<CorrectResponse>>()

    constructor(
        private baseUrl: string,
        private allowRemote: boolean,
        private timeoutMs = 8000,
    ) {}

    private guard(): void {
        if (!this.allowRemote && !isLocalBridgeUrl(this.baseUrl)) {
            throw new Error('bridge URL is not local; enable remote bridge in options to allow it')
        }
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        this.guard()
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
        try {
            const r = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            })
            if (!r.ok) throw new Error(`bridge ${path} ${r.status}`)
            // Some endpoints (e.g. /signal) reply 204 No Content with an empty
            // body. Calling r.json() on an empty body throws "Unexpected end of
            // JSON input", so treat 204 / empty as a no-value success.
            if (r.status === 204) return undefined as T
            const text = await r.text()
            return (text ? JSON.parse(text) : undefined) as T
        } finally {
            clearTimeout(t)
        }
    }

    private async get<T>(path: string): Promise<T> {
        this.guard()
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
        try {
            const r = await fetch(`${this.baseUrl}${path}`, { signal: ctrl.signal })
            if (!r.ok) throw new Error(`bridge ${path} ${r.status}`)
            return (await r.json()) as T
        } finally {
            clearTimeout(t)
        }
    }

    correct(req: CorrectRequest): Promise<CorrectResponse> {
        try {
            this.guard()
        } catch (e) {
            return Promise.reject(e)
        }
        const key = JSON.stringify({
            text: req.text,
            picky: req.picky ?? false,
            source: req.source,
        })
        const cached = this.inFlightCorrect.get(key)
        if (cached) return cached
        const p = this.post<CorrectResponse>('/correct', req).finally(() => {
            this.inFlightCorrect.delete(key)
        })
        this.inFlightCorrect.set(key, p)
        return p
    }

    // The bridge POST /signal takes a single { id, signal } per call (strict
    // JSON: unknown fields are rejected). The client batches events in a queue,
    // so we fan the batch out to one POST per event, mapping `action` -> the
    // bridge's `signal` field. Events without a correction id are dropped — the
    // bridge keys the signal on the correction-log row id, so an id-less event
    // is unattributable (it also avoids a guaranteed 400).
    async signal(events: SignalEvent[]): Promise<unknown> {
        const attributable = events.filter(
            (e): e is SignalEvent & { id: number } => typeof e.id === 'number' && e.id > 0,
        )
        await Promise.all(
            attributable.map((e) => this.post('/signal', { id: e.id, signal: e.action })),
        )
        return undefined
    }

    health(): Promise<{ status: string; premium?: boolean }> {
        return this.get<{ status: string; premium?: boolean }>('/health')
    }
}
