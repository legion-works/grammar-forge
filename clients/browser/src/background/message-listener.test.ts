import { describe, expect, it, vi } from 'vitest'
import {
    createBackgroundMessageListener,
    type BackgroundMessageListenerDependencies,
} from '@/background/message-listener'

const EXTENSION_ID = 'abcdefghijklmnopqrstuvwxyzabcdef'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`
const CONTENT_SENDER = { id: EXTENSION_ID, tab: { id: 7 } }
const SETTINGS = { bridgeBaseUrl: 'http://localhost:8000', allowRemoteBridge: false }
const RELAY_RESPONSE = {
    status: 200,
    ok: true,
    contentType: 'application/json',
    bodyText: '{"status":"ok"}',
}

function listenerDependencies() {
    const relayBridgeRequest = vi.fn<
        BackgroundMessageListenerDependencies['relayBridgeRequest']
    >(async () => RELAY_RESPONSE)
    return {
        extensionId: EXTENSION_ID,
        extensionOrigin: EXTENSION_ORIGIN,
        getSettings: vi.fn<BackgroundMessageListenerDependencies['getSettings']>(async () => SETTINGS),
        relayBridgeRequest,
        getTabStatus: vi.fn<BackgroundMessageListenerDependencies['getTabStatus']>(async () => ({
            type: 'TAB_STATUS',
            enabled: true,
        })),
    }
}

describe('createBackgroundMessageListener', () => {
    it('returns literal true and settles the asynchronous bridge response callback', async () => {
        const dependencies = listenerDependencies()
        const listener = createBackgroundMessageListener(dependencies)
        const sendResponse = vi.fn<(response: unknown) => void>()

        const keepsChannelOpen = listener(
            {
                type: 'BRIDGE_REQUEST',
                requestId: 'request-1',
                path: '/health',
                method: 'GET',
            },
            CONTENT_SENDER,
            sendResponse,
        )

        expect(keepsChannelOpen).toBe(true)
        await vi.waitFor(() =>
            expect(sendResponse).toHaveBeenCalledWith({ success: true, response: RELAY_RESPONSE }),
        )
    })

    it('serializes a relay failure through the callback', async () => {
        const dependencies = listenerDependencies()
        dependencies.relayBridgeRequest.mockRejectedValue(new Error('bridge unavailable'))
        const listener = createBackgroundMessageListener(dependencies)
        const sendResponse = vi.fn<(response: unknown) => void>()

        expect(
            listener(
                {
                    type: 'BRIDGE_REQUEST',
                    requestId: 'request-2',
                    path: '/health',
                    method: 'GET',
                },
                CONTENT_SENDER,
                sendResponse,
            ),
        ).toBe(true)
        await vi.waitFor(() =>
            expect(sendResponse).toHaveBeenCalledWith({ success: false, error: 'bridge unavailable' }),
        )
    })

    it('returns literal true and settles GET_TAB_STATUS through the callback', async () => {
        const dependencies = listenerDependencies()
        const listener = createBackgroundMessageListener(dependencies)
        const sendResponse = vi.fn<(response: unknown) => void>()

        expect(listener({ type: 'GET_TAB_STATUS' }, CONTENT_SENDER, sendResponse)).toBe(true)
        await vi.waitFor(() =>
            expect(sendResponse).toHaveBeenCalledWith({ type: 'TAB_STATUS', enabled: true }),
        )
    })

    it('cleans request ids after settle and after BRIDGE_CANCEL aborts the worker fetch', async () => {
        const dependencies = listenerDependencies()
        const listener = createBackgroundMessageListener(dependencies)
        const request = {
            type: 'BRIDGE_REQUEST' as const,
            requestId: 'reusable-request',
            path: '/health',
            method: 'GET' as const,
        }
        const settledResponse = vi.fn<(response: unknown) => void>()
        expect(listener(request, CONTENT_SENDER, settledResponse)).toBe(true)
        await vi.waitFor(() => expect(settledResponse).toHaveBeenCalled())

        let capturedSignal: AbortSignal | undefined
        dependencies.relayBridgeRequest.mockImplementation(
            async (_request, _settings, signal: AbortSignal) => {
                capturedSignal = signal
                return await new Promise<typeof RELAY_RESPONSE>((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(new DOMException('worker fetch aborted', 'AbortError'))
                    })
                })
            },
        )
        const abortedResponse = vi.fn<(response: unknown) => void>()

        expect(listener(request, CONTENT_SENDER, abortedResponse)).toBe(true)
        await vi.waitFor(() => expect(capturedSignal).toBeDefined())
        listener(
            { type: 'BRIDGE_CANCEL', requestId: 'reusable-request' },
            CONTENT_SENDER,
            vi.fn(),
        )
        expect(capturedSignal?.aborted).toBe(true)
        await vi.waitFor(() => expect(abortedResponse).toHaveBeenCalled())

        dependencies.relayBridgeRequest.mockResolvedValue(RELAY_RESPONSE)
        const secondResponse = vi.fn<(response: unknown) => void>()
        expect(listener(request, CONTENT_SENDER, secondResponse)).toBe(true)
        await vi.waitFor(() => expect(secondResponse).toHaveBeenCalled())
        expect(dependencies.relayBridgeRequest).toHaveBeenCalledTimes(3)
    })
})
