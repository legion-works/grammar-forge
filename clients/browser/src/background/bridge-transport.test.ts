import { describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '@/api/client'
import { createBackgroundBridgeFetch } from '@/background/bridge-transport'
import type { GfMessageMap } from '@/messaging/schema'

const FINAL = { original: 'teh', suggestions: [], score: 100 }

describe('createBackgroundBridgeFetch', () => {
    it('sends only a path, method, and body to the service worker', async () => {
        const sendMessage = vi
            .fn<(message: GfMessageMap['BRIDGE_REQUEST']) => Promise<unknown>>()
            .mockResolvedValue({
                status: 200,
                ok: true,
                contentType: 'application/json',
                bodyText: JSON.stringify(FINAL),
            })
        const transport = createBackgroundBridgeFetch('http://localhost:8000', sendMessage)

        const response = await transport('http://localhost:8000/correct', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'teh' }),
        })

        expect(sendMessage).toHaveBeenCalledWith({
            type: 'BRIDGE_REQUEST',
            path: '/correct',
            method: 'POST',
            body: JSON.stringify({ text: 'teh' }),
        })
        expect(await response.json()).toEqual(FINAL)
    })

    it('returns an unsupported response for streaming and lets BridgeClient fall back', async () => {
        const sendMessage = vi
            .fn<(message: GfMessageMap['BRIDGE_REQUEST']) => Promise<unknown>>()
            .mockResolvedValue({
                status: 200,
                ok: true,
                contentType: 'application/json',
                bodyText: JSON.stringify(FINAL),
            })
        const transport = createBackgroundBridgeFetch('http://localhost:8000', sendMessage)
        const client = new BridgeClient('http://localhost:8000', false, transport)
        const onFast = vi.fn<() => void>()

        const result = await client.correctStream({ text: 'teh', source: 'browser' }, onFast)

        expect(result).toEqual(FINAL)
        expect(onFast).not.toHaveBeenCalled()
        expect(sendMessage).toHaveBeenCalledOnce()
        expect(sendMessage.mock.calls[0]![0].path).toBe('/correct')
    })
})
