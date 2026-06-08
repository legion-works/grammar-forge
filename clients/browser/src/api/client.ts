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
            return (await r.json()) as T
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

    signal(events: SignalEvent[]): Promise<unknown> {
        return this.post('/signal', { events })
    }

    health(): Promise<{ status: string; premium?: boolean }> {
        return this.get<{ status: string; premium?: boolean }>('/health')
    }
}
