import type { BridgeFetch } from '@/api/client'
import type { BridgeRelayResponse, GfMessageMap } from '@/messaging/schema'

type BridgeMessageSender = (message: GfMessageMap['BRIDGE_REQUEST']) => Promise<unknown>

const NULL_BODY_STATUSES = new Set([204, 205, 304])

export function createBackgroundBridgeFetch(
    baseUrl: string,
    sendMessage: BridgeMessageSender = (message) => browser.runtime.sendMessage(message),
): BridgeFetch {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')

    return async (input, init) => {
        if (!input.startsWith(`${normalizedBaseUrl}/`)) {
            throw new Error('bridge transport input does not match the configured bridge URL')
        }
        const path = input.slice(normalizedBaseUrl.length)

        // Streaming needs a Port relay; a normal message deliberately takes
        // BridgeClient's existing unsupported-stream fallback until that lands.
        if (path === '/correct/stream') return new Response(null, { status: 501 })

        const method = init?.method ?? 'GET'
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
            throw new Error(`unsupported bridge request method: ${method}`)
        }
        if (init?.body !== undefined && typeof init.body !== 'string') {
            throw new Error('bridge request body must be serialized text')
        }

        const rawResponse = await sendMessage({
            type: 'BRIDGE_REQUEST',
            path,
            method,
            ...(init?.body === undefined ? {} : { body: init.body }),
        })
        if (!isBridgeRelayResponse(rawResponse)) {
            throw new Error('service worker returned an invalid bridge response')
        }

        const headers = rawResponse.contentType
            ? { 'content-type': rawResponse.contentType }
            : undefined
        const body = NULL_BODY_STATUSES.has(rawResponse.status) ? null : rawResponse.bodyText
        return new Response(body, { status: rawResponse.status, headers })
    }
}

function isBridgeRelayResponse(value: unknown): value is BridgeRelayResponse {
    if (typeof value !== 'object' || value === null) return false
    const response = value as Partial<BridgeRelayResponse>
    return (
        typeof response.status === 'number' &&
        typeof response.ok === 'boolean' &&
        typeof response.contentType === 'string' &&
        typeof response.bodyText === 'string'
    )
}
