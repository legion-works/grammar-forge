import { isLocalBridgeUrl } from '@/api/url'
import { parseSSEStream } from '@/api/sse'
import type {
    CompleteRequest,
    CompleteResponse,
    CorrectRequest,
    CorrectResponse,
    RephraseRequest,
    RephraseResponse,
    StatsResponse,
    SynonymsResponse,
    ToneResponse,
} from '@/api/types'

// Rephrase round-trips a (possibly remote, possibly reasoning) LLM; the
// bridge's own backend timeout is 30s, so mirror it client-side.
const REPHRASE_TIMEOUT_MS = 30_000

/** Distinguishes an in-band bridge `error` event (real pipeline failure —
 *  propagate) from transport/parse failures (fall back to /correct). */
class BridgeStreamError extends Error {}

export interface SignalEvent {
    id?: number
    action: 'accepted' | 'rejected' | 'ignored'
    category?: string
    source: string
}

export class BridgeClient {
    private readonly inFlightCorrect = new Map<string, Promise<CorrectResponse>>()
    /** Remembered after the first failed probe so old bridges (no
     *  /correct/stream route) pay exactly one extra request per page. */
    private streamUnsupported = false

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

    private async post<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T> {
        this.guard()
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), timeoutMs)
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

    private async del(path: string): Promise<void> {
        this.guard()
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
        try {
            const r = await fetch(`${this.baseUrl}${path}`, {
                method: 'DELETE',
                signal: ctrl.signal,
            })
            if (!r.ok && r.status !== 204) throw new Error(`bridge ${path} ${r.status}`)
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

    /**
     * Streaming variant of correct(): POST /correct/stream (SSE). onFast is
     * invoked with the fast-path preview frame (suggestions without ids —
     * preview-only, never signalable); the returned promise resolves with
     * the final frame, which is exactly the /correct response shape.
     * Transport/format failures (missing route, wrong content type, parse
     * errors) fall back to plain correct() and are remembered for the
     * session. An in-band `error` event is a REAL pipeline failure and
     * rejects without marking the stream unsupported.
     *
     * P1-9: `signal` (optional) lets the caller cancel a still-in-flight
     * stream — the content-script orchestrator threads one AbortController
     * per field through rerunFor so a NEW check aborts the PREVIOUS one's
     * connection instead of leaving it to run to completion server-side
     * with its result simply discarded by the seq guard.
     */
    async correctStream(
        req: CorrectRequest,
        onFast: (res: CorrectResponse) => void,
        signal?: AbortSignal,
    ): Promise<CorrectResponse> {
        if (this.streamUnsupported) return this.correct(req)
        this.guard()
        if (signal?.aborted) throw new DOMException('correctStream aborted before start', 'AbortError')
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
        const onExternalAbort = (): void => ctrl.abort()
        signal?.addEventListener('abort', onExternalAbort)
        try {
            let r: Response
            try {
                r = await fetch(`${this.baseUrl}/correct/stream`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(req),
                    signal: ctrl.signal,
                })
            } catch (e) {
                // Network-level failure: correct() would fail identically —
                // do not mark unsupported, just surface it. (Covers both the
                // timeout abort and an external cancellation — either way
                // the caller's seq guard will have already moved on.)
                throw e instanceof Error ? e : new Error(String(e))
            }
            if (!r.ok || !r.headers.get('content-type')?.includes('text/event-stream') || !r.body) {
                this.streamUnsupported = true
                return await this.correct(req)
            }
            let final: CorrectResponse | undefined
            try {
                for await (const ev of parseSSEStream(r.body)) {
                    if (ev.event === 'fast') {
                        try {
                            onFast(JSON.parse(ev.data) as CorrectResponse)
                        } catch {
                            // A malformed fast frame only costs the preview.
                        }
                    } else if (ev.event === 'final') {
                        final = JSON.parse(ev.data) as CorrectResponse
                    } else if (ev.event === 'error') {
                        let message = 'bridge stream error'
                        try {
                            message = (JSON.parse(ev.data) as { error?: string }).error ?? message
                        } catch {
                            // keep the generic message
                        }
                        throw new BridgeStreamError(message)
                    }
                }
            } catch (e) {
                if (e instanceof BridgeStreamError) throw new Error(e.message)
                if (ctrl.signal.aborted) {
                    // Cancelled (superseded check or explicit unmount) — never
                    // mark the stream unsupported or fall back to a full
                    // correct() call for a request nobody wants anymore.
                    throw e instanceof Error ? e : new Error(String(e))
                }
                // Malformed stream: fall back and remember.
                this.streamUnsupported = true
                return await this.correct(req)
            }
            if (!final) {
                this.streamUnsupported = true
                return await this.correct(req)
            }
            return final
        } finally {
            clearTimeout(t)
            signal?.removeEventListener('abort', onExternalAbort)
        }
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

    /**
     * Fire-and-forget variant of signal() for the page-unload path
     * (pagehide / visibilitychange->hidden). A plain fetch() started this
     * late is routinely aborted mid-flight once the page starts tearing
     * down; `keepalive` (and, where available, `navigator.sendBeacon`) lets
     * the request survive past unload. Never awaited, never retried — by
     * design there is no "next flush" once the page is gone.
     */
    signalOnUnload(events: SignalEvent[]): void {
        try {
            this.guard()
        } catch {
            return
        }
        const attributable = events.filter(
            (e): e is SignalEvent & { id: number } => typeof e.id === 'number' && e.id > 0,
        )
        for (const e of attributable) {
            const url = `${this.baseUrl}/signal`
            const body = JSON.stringify({ id: e.id, signal: e.action })
            if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
                try {
                    const blob = new Blob([body], { type: 'application/json' })
                    if (navigator.sendBeacon(url, blob)) continue
                } catch {
                    // fall through to keepalive fetch
                }
            }
            try {
                void fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                    keepalive: true,
                }).catch(() => {})
            } catch {
                // Best-effort: the page is going away, nothing more we can do.
            }
        }
    }

    health(): Promise<{ status: string; premium?: boolean }> {
        return this.get<{ status: string; premium?: boolean }>('/health')
    }

    rephrase(req: RephraseRequest): Promise<RephraseResponse> {
        try {
            this.guard()
        } catch (e) {
            return Promise.reject(e)
        }
        const body: Record<string, unknown> = {
            text: req.text,
            source: req.source,
        }
        if (req.tone) body.tone = req.tone
        if (req.style) body.style = req.style
        if (req.alternatives && req.alternatives > 1) body.alternatives = req.alternatives
        if (req.override) {
            body.override = {
                provider: req.override.provider,
                base_url: req.override.baseUrl,
                model: req.override.model,
                api_key: req.override.apiKey,
            }
        }
        return this.post<RephraseResponse>('/rephrase', body, REPHRASE_TIMEOUT_MS)
    }

    dictionaryList(): Promise<{ words: string[] }> {
        return this.get<{ words: string[] }>('/dictionary')
    }

    dictionaryAdd(word: string): Promise<unknown> {
        return this.post('/dictionary', { word })
    }

    dictionaryRemove(word: string): Promise<void> {
        return this.del(`/dictionary/${encodeURIComponent(word)}`)
    }

    // ── Redesign endpoints (W2-foundation) ──────────────────────────────────
    // The endpoint shapes are a runtime contract with the bridge:
    //   GET  /stats    → StatsResponse
    //   POST /tone     → ToneResponse  ({text, granularity?})
    //   GET  /synonyms → SynonymsResponse (?word=X)
    // They are added here as typed methods so every W2 surface can call them
    // without re-deriving the URL/payload shape. Errors propagate via the
    // shared `get`/`post` helpers (`bridge <path> <status>`).

    stats(): Promise<StatsResponse> {
        return this.get<StatsResponse>('/stats')
    }

    tone(text: string, granularity?: 'field' | 'sentence'): Promise<ToneResponse> {
        const body: Record<string, unknown> = { text }
        if (granularity) body.granularity = granularity
        return this.post<ToneResponse>('/tone', body)
    }

    synonyms(word: string): Promise<SynonymsResponse> {
        return this.get<SynonymsResponse>(`/synonyms?word=${encodeURIComponent(word)}`)
    }

    complete(req: CompleteRequest): Promise<CompleteResponse> {
        try {
            this.guard()
        } catch (e) {
            return Promise.reject(e)
        }
        const body: Record<string, unknown> = {
            text: req.text,
            source: req.source,
        }
        if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens
        if (req.temperature !== undefined) body.temperature = req.temperature
        return this.post<CompleteResponse>('/complete', body, REPHRASE_TIMEOUT_MS)
    }
}
