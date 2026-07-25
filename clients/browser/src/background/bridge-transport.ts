import type { BridgeFetch } from '@/api/client'
import type {
    BridgeRelayMessageResponse,
    BridgeRelayResponse,
    GfMessage,
} from '@/messaging/schema'

type BridgeMessageSender = (message: GfMessage) => Promise<unknown>
type BridgeRequestIdFactory = () => string

const NULL_BODY_STATUSES = new Set([204, 205, 304])

export function createBackgroundBridgeFetch(
    baseUrl: string,
    sendMessage: BridgeMessageSender = (message) => browser.runtime.sendMessage(message),
    createRequestId: BridgeRequestIdFactory = () => crypto.randomUUID(),
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

        const requestId = createRequestId()
        const rawResponse = await sendWithCancellation(
            sendMessage,
            {
                type: 'BRIDGE_REQUEST',
                requestId,
                path,
                method,
                ...(init?.body === undefined ? {} : { body: init.body }),
            },
            init?.signal,
        )
        if (!isBridgeRelayMessageResponse(rawResponse)) {
            throw new Error('service worker returned an invalid bridge response')
        }
        if (!rawResponse.success) throw new Error(rawResponse.error)
        const bridgeResponse = rawResponse.response

        const headers = bridgeResponse.contentType
            ? { 'content-type': bridgeResponse.contentType }
            : undefined
        const body = NULL_BODY_STATUSES.has(bridgeResponse.status) ? null : bridgeResponse.bodyText
        return new Response(body, { status: bridgeResponse.status, headers })
    }
}

async function sendWithCancellation(
    sendMessage: BridgeMessageSender,
    request: Extract<GfMessage, { type: 'BRIDGE_REQUEST' }>,
    signal?: AbortSignal | null,
): Promise<unknown> {
    if (signal?.aborted) throw abortReason(signal)

    return await new Promise<unknown>((resolve, reject) => {
        let settled = false
        const settle = (callback: () => void): void => {
            if (settled) return
            settled = true
            signal?.removeEventListener('abort', onAbort)
            callback()
        }
        const onAbort = (): void => {
            settle(() => {
                try {
                    void sendMessage({ type: 'BRIDGE_CANCEL', requestId: request.requestId }).catch(
                        () => {},
                    )
                } catch {
                    // Cancellation is best-effort after the local caller has already aborted.
                }
                reject(abortReason(signal!))
            })
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        try {
            void sendMessage(request).then(
                (response) => settle(() => resolve(response)),
                (error: unknown) => settle(() => reject(error)),
            )
        } catch (error) {
            settle(() => reject(error))
        }
    })
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function isBridgeRelayMessageResponse(value: unknown): value is BridgeRelayMessageResponse {
    if (typeof value !== 'object' || value === null) return false
    const message = value as Partial<BridgeRelayMessageResponse>
    if (message.success === false) return typeof message.error === 'string'
    if (message.success !== true || !isBridgeRelayResponse(message.response)) return false
    return true
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
