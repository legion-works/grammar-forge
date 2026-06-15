import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '@/api/client'

afterEach(() => vi.restoreAllMocks())

describe('BridgeClient.correct', () => {
    it('POSTs /correct and returns parsed suggestions', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    original: 'teh',
                    suggestions: [
                        {
                            span: { start: 0, end: 3 },
                            replacement: 'the',
                            model: 'harper',
                            category: 'spelling',
                        },
                    ],
                    score: 90,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.correct({ text: 'teh', source: 'browser' })
        expect(res.suggestions[0]!.category).toBe('spelling')
        expect(fetchMock).toHaveBeenCalledOnce()
    })
    it('refuses a non-local URL when allowRemote is false', async () => {
        const c = new BridgeClient('http://evil.com', false)
        await expect(c.correct({ text: 'x', source: 'browser' })).rejects.toThrow(/local/i)
    })
    it('deduplicates identical concurrent /correct calls into one fetch', async () => {
        let resolveFetch: ((v: Response) => void) | undefined
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(
            () =>
                new Promise<Response>((res) => {
                    resolveFetch = res
                }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        const a = c.correct({ text: 'teh', source: 'browser' })
        const b = c.correct({ text: 'teh', source: 'browser' })
        expect(fetchMock).toHaveBeenCalledOnce()
        const body = JSON.stringify({
            original: 'teh',
            suggestions: [],
            score: 100,
        })
        resolveFetch!(
            new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        )
        const [ra, rb] = await Promise.all([a, b])
        expect(ra).toEqual(rb)
        expect(fetchMock).toHaveBeenCalledOnce()
        // after resolution, a new identical call issues a fresh fetch
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        await c.correct({ text: 'teh', source: 'browser' })
        expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    })
})

describe('BridgeClient.signal', () => {
    it('POSTs one {id, signal} per attributable event (action -> signal)', async () => {
        const bodies: unknown[] = []
        const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
            bodies.push(JSON.parse(String(init?.body)))
            return Promise.resolve(new Response(null, { status: 204 }))
        })
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        await c.signal([
            { id: 7, action: 'accepted', category: 'grammar', source: 'browser' },
            { id: 9, action: 'ignored', source: 'browser' },
        ])
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(bodies).toContainEqual({ id: 7, signal: 'accepted' })
        expect(bodies).toContainEqual({ id: 9, signal: 'ignored' })
    })
    it('drops events without a correction id (unattributable -> no POST)', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        await c.signal([{ action: 'accepted', source: 'browser' }])
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('BridgeClient.health', () => {
    it('GETs /health, times out, and throws on non-ok', async () => {
        const ok = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ status: 'ok', premium: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', ok)
        const c = new BridgeClient('http://localhost:8000', true)
        const h = await c.health()
        expect(h.status).toBe('ok')
        expect(h.premium).toBe(true)

        const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 503 }))
        vi.stubGlobal('fetch', bad)
        await expect(c.health()).rejects.toThrow(/health.*503/)
    })
    it('refuses a non-local URL when allowRemote is false', async () => {
        const c = new BridgeClient('http://evil.com', false)
        await expect(c.health()).rejects.toThrow(/local/i)
    })
})

describe('BridgeClient.rephrase', () => {
    it('POSTs /rephrase with snake_cased override and returns the parsed response', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
                JSON.stringify({
                    original: 'i has went',
                    rephrased: 'I have gone',
                    alternatives: ['I went'],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.rephrase({
            text: 'i has went',
            tone: 'formal',
            alternatives: 2,
            source: 'browser',
            override: {
                provider: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                model: 'claude-x',
                apiKey: 'secret',
            },
        })
        expect(res.rephrased).toBe('I have gone')
        expect(res.alternatives).toEqual(['I went'])
        expect(fetchMock).toHaveBeenCalledOnce()
        const call = fetchMock.mock.calls[0]!
        expect(String(call[0])).toBe('http://localhost:8000/rephrase')
        const body = JSON.parse((call[1] as RequestInit).body as string)
        expect(body.override.base_url).toBe('https://api.anthropic.com')
        expect(body.override.api_key).toBe('secret')
        expect(body.override.provider).toBe('anthropic')
        expect(body.alternatives).toBe(2)
        expect(body.tone).toBe('formal')
    })

    it('omits the override when none is configured', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ original: 'x', rephrased: 'y', alternatives: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        await c.rephrase({ text: 'x', source: 'browser' })
        const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
        expect(body.override).toBeUndefined()
    })

    it('rephrase aborts at 30s, not the default 8s', async () => {
        vi.useFakeTimers()
        const originalFetch = globalThis.fetch
        let abortedAt: number | null = null
        const start = Date.now()
        globalThis.fetch = vi.fn<typeof fetch>((_url, init) => {
            return new Promise((_resolve, reject) => {
                ;(init as RequestInit).signal?.addEventListener('abort', () => {
                    abortedAt = Date.now() - start
                    reject(new DOMException('aborted', 'AbortError'))
                })
            })
        })
        const client = new BridgeClient('http://localhost:8000', false)
        const p = client.rephrase({ text: 'x', source: 'browser' }).catch(() => 'aborted')
        await vi.advanceTimersByTimeAsync(8001)
        expect(abortedAt).toBeNull() // must NOT abort at the correct-path 8s
        await vi.advanceTimersByTimeAsync(22000)
        expect(await p).toBe('aborted')
        vi.useRealTimers()
        globalThis.fetch = originalFetch
    })
})

describe('BridgeClient.dictionary', () => {
    it('dictionaryList GETs /dictionary', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ words: ['alpha', 'beta'] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', false)
        const res = await c.dictionaryList()
        expect(res.words).toEqual(['alpha', 'beta'])
        expect(String(fetchMock.mock.calls[0]![0])).toBe('http://localhost:8000/dictionary')
    })

    it('dictionaryAdd POSTs the word', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', false)
        await c.dictionaryAdd('gamma')
        const init = fetchMock.mock.calls[0]![1] as RequestInit
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body as string)).toEqual({ word: 'gamma' })
    })

    it('dictionaryRemove DELETEs the url-encoded word', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', false)
        await c.dictionaryRemove('two words')
        expect(String(fetchMock.mock.calls[0]![0])).toBe(
            'http://localhost:8000/dictionary/two%20words',
        )
        expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE')
    })
})

describe('BridgeClient.stats', () => {
    it('GETs /stats and returns the typed StatsResponse with redesign fields', async () => {
        const payload = {
            corrections: 10,
            edits_total: 20,
            edits_accepted: 15,
            edits_rejected: 3,
            edits_ignored: 2,
            acceptance_rate: 0.75,
            top_issues: { spelling: 3, grammar: 2 },
            streak: 4,
            words_this_week: 120,
        }
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.stats()
        expect(res.corrections).toBe(10)
        expect(res.streak).toBe(4)
        expect(res.words_this_week).toBe(120)
        expect(res.top_issues['spelling']).toBe(3)
        expect(res.top_issues['grammar']).toBe(2)
        expect(res.acceptance_rate).toBe(0.75)
        expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
            'http://localhost:8000/stats',
        )
    })
    it('throws on a non-200 from /stats', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 500 })),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        await expect(c.stats()).rejects.toThrow(/stats.*500/)
    })
    it('refuses a non-local URL when allowRemote is false', async () => {
        const c = new BridgeClient('http://evil.com', false)
        await expect(c.stats()).rejects.toThrow(/local/i)
    })
})

describe('BridgeClient.tone', () => {
    it('POSTs /tone with text and optional granularity and returns the typed ToneResponse', async () => {
        const payload = {
            tags: [
                { tag: 'formal', score: 0.9 },
                { tag: 'neutral', score: 0.1 },
            ],
        }
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify(payload), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.tone('Hello world.', 'field')
        expect(res.tags[0]!.tag).toBe('formal')
        expect(res.tags[0]!.score).toBe(0.9)
        expect(res.sentences).toBeUndefined()
        const call = fetchMock.mock.calls[0]!
        expect(String(call[0])).toBe('http://localhost:8000/tone')
        expect((call[1] as RequestInit).method).toBe('POST')
        const body = JSON.parse((call[1] as RequestInit).body as string)
        expect(body.text).toBe('Hello world.')
        expect(body.granularity).toBe('field')
    })
    it('omits granularity when not provided', async () => {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ tags: [] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )
        vi.stubGlobal('fetch', fetchMock)
        const c = new BridgeClient('http://localhost:8000', true)
        await c.tone('Hi')
        const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
        expect(body.text).toBe('Hi')
        expect(body.granularity).toBeUndefined()
    })
    it('parses per-sentence tags when the bridge returns them', async () => {
        const payload = {
            tags: [{ tag: 'neutral', score: 1 }],
            sentences: [
                {
                    span: { start: 0, end: 5 },
                    tags: [{ tag: 'formal', score: 0.7 }],
                },
            ],
        }
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.tone('Hello world.', 'sentence')
        expect(res.sentences).toHaveLength(1)
        expect(res.sentences![0]!.span.start).toBe(0)
        expect(res.sentences![0]!.tags[0]!.tag).toBe('formal')
    })
    it('throws on a non-200 from /tone', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 503 })),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        await expect(c.tone('Hi')).rejects.toThrow(/tone.*503/)
    })
})

describe('BridgeClient.synonyms', () => {
    it('GETs /synonyms?word=X and returns the typed SynonymsResponse', async () => {
        const payload = { word: 'happy', synonyms: ['glad', 'joyful'] }
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.synonyms('happy')
        expect(res.word).toBe('happy')
        expect(res.synonyms).toEqual(['glad', 'joyful'])
        expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
            'http://localhost:8000/synonyms?word=happy',
        )
    })
    it('URL-encodes multi-word queries', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(JSON.stringify({ word: 'pro bono', synonyms: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.synonyms('pro bono')
        expect(res.word).toBe('pro bono')
        expect(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toBe(
            'http://localhost:8000/synonyms?word=pro%20bono',
        )
    })
    it('returns an empty array when the bridge returns no synonyms', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(
                new Response(JSON.stringify({ word: 'zzz', synonyms: [] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            ),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        const res = await c.synonyms('zzz')
        expect(res.synonyms).toEqual([])
    })
    it('throws on a non-200 from /synonyms', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 404 })),
        )
        const c = new BridgeClient('http://localhost:8000', true)
        await expect(c.synonyms('happy')).rejects.toThrow(/synonyms.*404/)
    })
    it('refuses a non-local URL when allowRemote is false', async () => {
        const c = new BridgeClient('http://evil.com', false)
        await expect(c.synonyms('happy')).rejects.toThrow(/local/i)
    })
})

const FINAL = {
    original: 'I has a cat',
    suggestions: [
        { id: 7, span: { start: 2, end: 5 }, replacement: 'have', model: 'llm' as const },
    ],
    score: 95,
}
const FAST = {
    original: 'I has a cat',
    suggestions: [{ span: { start: 2, end: 5 }, replacement: 'have', model: 'gector' as const }],
    score: 90,
    stage: 'fast',
}

function sseResponse(body: string): Response {
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    })
}

describe('BridgeClient.correctStream', () => {
    it('delivers the fast frame then resolves with final', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn<typeof fetch>()
                .mockResolvedValue(
                    sseResponse(
                        `event: fast\ndata: ${JSON.stringify(FAST)}\n\nevent: final\ndata: ${JSON.stringify(FINAL)}\n\n`,
                    ),
                ),
        )
        const client = new BridgeClient('http://localhost:8000', false)
        const fastFrames: unknown[] = []
        const final = await client.correctStream({ text: 'I has a cat', source: 'browser' }, (f) =>
            fastFrames.push(f),
        )
        // T5b client side: bridge T5a now emits ≥1 fast frames
        // (one per fast corrector). The parser iterates every SSE
        // event; the assertion is "at least one" — the parser was
        // already correct for N frames.
        expect(fastFrames.length).toBeGreaterThanOrEqual(1)
        expect(final).toEqual(FINAL)
    })

    it('delivers N fast frames in order, then final (T5b multi-frame)', async () => {
        // Bridge T5a emits one fast event per fast corrector. The
        // client must render each incrementally (the user's preview
        // refines as later fast correctors complete). Build a stream
        // with 2 distinct fast frames + final and assert the order.
        const FAST_A = {
            ...FAST,
            suggestions: [
                { span: { start: 2, end: 5 }, replacement: 'have', model: 'gector' as const },
            ],
        }
        const FAST_B = {
            ...FAST,
            suggestions: [
                { span: { start: 2, end: 5 }, replacement: 'have', model: 'harper' as const },
                { span: { start: 6, end: 7 }, replacement: 'a', model: 'harper' as const },
            ],
        }
        const stream =
            `event: fast\ndata: ${JSON.stringify(FAST_A)}\n\n` +
            `event: fast\ndata: ${JSON.stringify(FAST_B)}\n\n` +
            `event: final\ndata: ${JSON.stringify(FINAL)}\n\n`
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(sseResponse(stream)))
        const client = new BridgeClient('http://localhost:8000', false)
        const fastFrames: unknown[] = []
        const final = await client.correctStream({ text: 'I has a cat', source: 'browser' }, (f) =>
            fastFrames.push(f),
        )
        expect(fastFrames).toHaveLength(2)
        // Order preserved: FAST_A first, FAST_B second.
        expect(fastFrames[0]).toEqual(FAST_A)
        expect(fastFrames[1]).toEqual(FAST_B)
        expect(final).toEqual(FINAL)
    })

    it('falls back to /correct on 404 and remembers', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            // first stream attempt: 404
            .mockResolvedValueOnce(new Response('not found', { status: 404 }))
            // fallback /correct
            .mockResolvedValueOnce(new Response(JSON.stringify(FINAL), { status: 200 }))
            // second call goes straight to /correct (remembered)
            .mockResolvedValueOnce(new Response(JSON.stringify(FINAL), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const client = new BridgeClient('http://localhost:8000', false)
        const onFast = vi.fn<() => void>()
        await client.correctStream({ text: 'a b c', source: 'browser' }, onFast)
        await client.correctStream({ text: 'd e f', source: 'browser' }, onFast)
        expect(onFast).not.toHaveBeenCalled()
        const urls = fetchMock.mock.calls.map((c) => String(c[0]))
        expect(urls[0]).toContain('/correct/stream')
        expect(urls[1]).toContain('/correct')
        expect(urls[1]).not.toContain('/stream')
        expect(urls[2]).toContain('/correct')
        expect(urls[2]).not.toContain('/stream')
    })

    it('falls back when the response is not an event stream', async () => {
        const fetchMock = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(JSON.stringify(FINAL), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(FINAL), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const client = new BridgeClient('http://localhost:8000', false)
        const final = await client.correctStream({ text: 'a b c', source: 'browser' }, () => {})
        expect(final).toEqual(FINAL)
    })

    it('throws on an in-band bridge error event without falling back', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn<typeof fetch>()
                .mockResolvedValue(
                    sseResponse(
                        `event: fast\ndata: ${JSON.stringify(FAST)}\n\nevent: error\ndata: {"error":"correction backend unavailable"}\n\n`,
                    ),
                ),
        )
        const client = new BridgeClient('http://localhost:8000', false)
        await expect(
            client.correctStream({ text: 'a b c', source: 'browser' }, () => {}),
        ).rejects.toThrow(/unavailable/)
    })
})
