import { describe, expect, it, vi } from 'vitest'
import { relayBridgeRequest } from '@/background/bridge-relay'

const LOCAL_SETTINGS = {
    bridgeBaseUrl: 'http://localhost:8000',
    allowRemoteBridge: false,
}

describe('relayBridgeRequest', () => {
    it('composes the configured bridge URL after accepting an allowlisted route', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
            new Response('{"status":"ok"}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        )

        const result = await relayBridgeRequest(
            { type: 'BRIDGE_REQUEST', path: '/health', method: 'GET' },
            LOCAL_SETTINGS,
            fetcher,
        )

        expect(fetcher).toHaveBeenCalledWith('http://localhost:8000/health', {
            method: 'GET',
            headers: undefined,
            body: undefined,
        })
        expect(result).toEqual({
            status: 200,
            ok: true,
            contentType: 'application/json',
            bodyText: '{"status":"ok"}',
        })
    })

    it.each([
        ['https://attacker.example/steal', 'GET'],
        ['//attacker.example/steal', 'GET'],
        ['/admin', 'GET'],
        ['/health?redirect=https://attacker.example', 'GET'],
        ['/dictionary/word/extra', 'DELETE'],
        ['/correct', 'GET'],
    ])('rejects non-allowlisted request %s %s before fetch', async (path, method) => {
        const fetcher = vi.fn<typeof fetch>()

        await expect(
            relayBridgeRequest(
                { type: 'BRIDGE_REQUEST', path, method: method as 'GET' | 'POST' | 'DELETE' },
                LOCAL_SETTINGS,
                fetcher,
            ),
        ).rejects.toThrow(/bridge route/i)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it('preserves the local-only guard using settings read by the worker', async () => {
        const fetcher = vi.fn<typeof fetch>()

        await expect(
            relayBridgeRequest(
                { type: 'BRIDGE_REQUEST', path: '/health', method: 'GET' },
                { bridgeBaseUrl: 'https://attacker.example', allowRemoteBridge: false },
                fetcher,
            ),
        ).rejects.toThrow(/local/i)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it.each([
        ['/correct', 'POST'],
        ['/correct/stream', 'POST'],
        ['/rephrase', 'POST'],
        ['/signal', 'POST'],
        ['/health', 'GET'],
        ['/stats', 'GET'],
        ['/tone', 'POST'],
        ['/complete', 'POST'],
        ['/synonyms?word=happy', 'GET'],
        ['/dictionary', 'GET'],
        ['/dictionary', 'POST'],
        ['/dictionary/hello%20world', 'DELETE'],
    ])('allows bridge route %s %s', async (path, method) => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))

        await relayBridgeRequest(
            { type: 'BRIDGE_REQUEST', path, method: method as 'GET' | 'POST' | 'DELETE' },
            LOCAL_SETTINGS,
            fetcher,
        )

        expect(fetcher).toHaveBeenCalledOnce()
    })
})
