import { isLocalBridgeUrl } from '@/api/url'
import type { BridgeRelayResponse, BridgeRequestMethod, GfMessageMap } from '@/messaging/schema'

interface BridgeSettings {
    bridgeBaseUrl: string
    allowRemoteBridge: boolean
}

const BRIDGE_ROUTE_METHODS: Readonly<Record<string, readonly BridgeRequestMethod[]>> = {
    '/correct': ['POST'],
    '/correct/stream': ['POST'],
    '/rephrase': ['POST'],
    '/signal': ['POST'],
    '/health': ['GET'],
    '/stats': ['GET'],
    '/tone': ['POST'],
    '/complete': ['POST'],
    '/synonyms': ['GET'],
    '/dictionary': ['GET', 'POST'],
}

const RELATIVE_PATH_BASE = 'https://grammarforge.invalid'

export async function relayBridgeRequest(
    request: GfMessageMap['BRIDGE_REQUEST'],
    settings: BridgeSettings,
    fetcher: typeof fetch = fetch,
): Promise<BridgeRelayResponse> {
    validateBridgeRoute(request.path, request.method)
    if (!settings.allowRemoteBridge && !isLocalBridgeUrl(settings.bridgeBaseUrl)) {
        throw new Error('bridge URL is not local; enable remote bridge in options to allow it')
    }

    const baseUrl = settings.bridgeBaseUrl.replace(/\/+$/, '')
    const response = await fetcher(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: request.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: request.body,
    })
    return {
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get('content-type') ?? '',
        bodyText: await response.text(),
    }
}

function validateBridgeRoute(path: string, method: BridgeRequestMethod): void {
    if (!path.startsWith('/') || path.startsWith('//')) throw invalidBridgeRoute(path, method)

    let parsed: URL
    try {
        parsed = new URL(path, RELATIVE_PATH_BASE)
    } catch {
        throw invalidBridgeRoute(path, method)
    }
    if (parsed.origin !== RELATIVE_PATH_BASE || path !== `${parsed.pathname}${parsed.search}`) {
        throw invalidBridgeRoute(path, method)
    }

    if (parsed.pathname.startsWith('/dictionary/')) {
        const dictionaryWord = parsed.pathname.slice('/dictionary/'.length)
        if (
            method === 'DELETE' &&
            dictionaryWord.length > 0 &&
            !dictionaryWord.includes('/') &&
            parsed.search === ''
        ) {
            return
        }
        throw invalidBridgeRoute(path, method)
    }

    const allowedMethods = BRIDGE_ROUTE_METHODS[parsed.pathname]
    if (!allowedMethods?.includes(method)) throw invalidBridgeRoute(path, method)

    if (parsed.pathname === '/synonyms') {
        if (
            parsed.searchParams.getAll('word').length === 1 &&
            parsed.searchParams.get('word') !== '' &&
            [...parsed.searchParams.keys()].every((key) => key === 'word')
        ) {
            return
        }
        throw invalidBridgeRoute(path, method)
    }
    if (parsed.search !== '') throw invalidBridgeRoute(path, method)
}

function invalidBridgeRoute(path: string, method: unknown): Error {
    return new Error(`bridge route is not allowed: ${String(method)} ${path}`)
}
