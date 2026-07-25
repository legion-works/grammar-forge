import type {
    BridgeRelayMessageResponse,
    BridgeRelayResponse,
    GfMessageMap,
} from '@/messaging/schema'
import { isMessage, isTrustedSender } from '@/messaging/schema'

interface BridgeSettings {
    bridgeBaseUrl: string
    allowRemoteBridge: boolean
}

interface BackgroundMessageSender {
    id?: string
    tab?: { id?: number }
    url?: string
}

export interface BackgroundMessageListenerDependencies {
    extensionId: string
    extensionOrigin: string
    getSettings: () => Promise<BridgeSettings>
    relayBridgeRequest: (
        request: GfMessageMap['BRIDGE_REQUEST'],
        settings: BridgeSettings,
        signal: AbortSignal,
    ) => Promise<BridgeRelayResponse>
    getTabStatus: () => Promise<unknown>
}

type BackgroundMessageListener = (
    raw: unknown,
    sender: BackgroundMessageSender,
    sendResponse: (response: unknown) => void,
) => true | undefined

export function createBackgroundMessageListener(
    dependencies: BackgroundMessageListenerDependencies,
): BackgroundMessageListener {
    const inFlightBridgeRequests = new Map<string, AbortController>()

    return (raw, sender, sendResponse) => {
        if (
            !isTrustedSender(
                sender,
                dependencies.extensionId,
                dependencies.extensionOrigin,
            )
        ) {
            return undefined
        }

        if (isMessage(raw, 'BRIDGE_CANCEL')) {
            const controller = inFlightBridgeRequests.get(raw.requestId)
            controller?.abort()
            inFlightBridgeRequests.delete(raw.requestId)
            return undefined
        }

        if (isMessage(raw, 'BRIDGE_REQUEST')) {
            if (inFlightBridgeRequests.has(raw.requestId)) {
                sendResponse({
                    success: false,
                    error: `duplicate bridge request id: ${raw.requestId}`,
                } satisfies BridgeRelayMessageResponse)
                return true
            }

            const controller = new AbortController()
            inFlightBridgeRequests.set(raw.requestId, controller)
            void dependencies
                .getSettings()
                .then((settings) =>
                    dependencies.relayBridgeRequest(raw, settings, controller.signal),
                )
                .then((response) =>
                    sendResponse({ success: true, response } satisfies BridgeRelayMessageResponse),
                )
                .catch((error: unknown) =>
                    sendResponse({
                        success: false,
                        error: errorMessage(error),
                    } satisfies BridgeRelayMessageResponse),
                )
                .finally(() => {
                    if (inFlightBridgeRequests.get(raw.requestId) === controller) {
                        inFlightBridgeRequests.delete(raw.requestId)
                    }
                })
            // Chrome before 148 ignores Promise listener returns; literal true
            // keeps the callback response channel open across all target versions.
            return true
        }

        if (isMessage(raw, 'GET_TAB_STATUS')) {
            void dependencies.getTabStatus().then(sendResponse, () =>
                sendResponse({
                    type: 'TAB_STATUS',
                    enabled: false,
                    fieldCount: 0,
                    hostname: '',
                    counts: {},
                }),
            )
            return true
        }

        return undefined
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
