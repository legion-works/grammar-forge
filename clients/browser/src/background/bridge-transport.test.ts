import { describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '@/api/client'
import { createBackgroundBridgeFetch } from '@/background/bridge-transport'

const FINAL = { original: 'teh', suggestions: [], score: 100 }

describe('createBackgroundBridgeFetch', () => {
    it('sends only a path, method, and body to the service worker', async () => {
        const sendMessage = vi
            .fn<(message: unknown) => Promise<unknown>>()
            .mockResolvedValue({
                success: true,
                response: {
                    status: 200,
                    ok: true,
                    contentType: 'application/json',
                    bodyText: JSON.stringify(FINAL),
                },
            })
        const transport = createBackgroundBridgeFetch(
            'http://localhost:8000',
            sendMessage,
            () => 'request-1',
        )

        const response = await transport('http://localhost:8000/correct', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'teh' }),
        })

        expect(sendMessage).toHaveBeenCalledWith({
            type: 'BRIDGE_REQUEST',
            requestId: 'request-1',
            path: '/correct',
            method: 'POST',
            body: JSON.stringify({ text: 'teh' }),
        })
        expect(await response.json()).toEqual(FINAL)
    })

    it('returns an unsupported response for streaming and lets BridgeClient fall back', async () => {
        const sendMessage = vi
            .fn<(message: unknown) => Promise<unknown>>()
            .mockResolvedValue({
                success: true,
                response: {
                    status: 200,
                    ok: true,
                    contentType: 'application/json',
                    bodyText: JSON.stringify(FINAL),
                },
            })
        const transport = createBackgroundBridgeFetch('http://localhost:8000', sendMessage)
        const client = new BridgeClient('http://localhost:8000', false, transport)
        const onFast = vi.fn<() => void>()

        const result = await client.correctStream({ text: 'teh', source: 'browser' }, onFast)

        expect(result).toEqual(FINAL)
        expect(onFast).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalledOnce()
        expect((sendMessage.mock.calls[0]![0] as { path?: string }).path).toBe('/correct')
    })

    it('propagates a serialized worker error', async () => {
        const sendMessage = vi
            .fn<(message: unknown) => Promise<unknown>>()
            .mockResolvedValue({ success: false, error: 'bridge route rejected' })
        const transport = createBackgroundBridgeFetch(
            'http://localhost:8000',
            sendMessage,
            () => 'request-2',
        )

        await expect(transport('http://localhost:8000/health')).rejects.toThrow(
            'bridge route rejected',
        )
    })

    it('aborts a non-settling relay at the BridgeClient timeout and cancels the worker request', async () => {
        const messages: unknown[] = []
        const sendMessage = vi.fn<(message: unknown) => Promise<unknown>>((message) => {
            messages.push(message)
            if ((message as { type?: string }).type === 'BRIDGE_CANCEL') return Promise.resolve(undefined)
            return new Promise<unknown>(() => {})
        })
        const transport = createBackgroundBridgeFetch(
            'http://localhost:8000',
            sendMessage,
            () => 'request-timeout',
        )
        const client = new BridgeClient('http://localhost:8000', false, transport, 5)

        const outcome = await Promise.race([
            client.health().then(
                () => 'resolved',
                (error: unknown) => (error as { name?: string }).name ?? 'rejected',
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
        ])

        expect(outcome).toBe('AbortError')
        expect(messages).toContainEqual({ type: 'BRIDGE_CANCEL', requestId: 'request-timeout' })
    })
})
