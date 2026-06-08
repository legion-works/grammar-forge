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
