// Typed contracts for messages between the background service worker,
// content scripts, and extension pages. Network requests cross this boundary
// as relative bridge paths so the worker cannot become an arbitrary URL proxy.

import type { Category } from '@/api/types'

export type BridgeRequestMethod = 'GET' | 'POST' | 'DELETE'

export interface BridgeRelayResponse {
    status: number
    ok: boolean
    contentType: string
    bodyText: string
}

/** Discriminated union of every message that may cross the boundary. */
export type GfMessage =
    | { type: 'TRIGGER_CHECK' }
    | { type: 'GET_TAB_STATUS' }
    | { type: 'REPHRASE_SELECTION' }
    | {
          type: 'BRIDGE_REQUEST'
          path: string
          method: BridgeRequestMethod
          body?: string
      }
    | {
          type: 'TAB_STATUS'
          enabled: boolean
          fieldCount: number
          hostname: string
          /** Per-category counts on the FOCUSED field's last check, if any. */
          counts: Partial<Record<Category, number>>
      }

/** Map of message type tag → full payload, for type-safe senders. */
export interface GfMessageMap {
    TRIGGER_CHECK: { type: 'TRIGGER_CHECK' }
    GET_TAB_STATUS: { type: 'GET_TAB_STATUS' }
    REPHRASE_SELECTION: { type: 'REPHRASE_SELECTION' }
    BRIDGE_REQUEST: {
        type: 'BRIDGE_REQUEST'
        path: string
        method: BridgeRequestMethod
        body?: string
    }
    TAB_STATUS: {
        type: 'TAB_STATUS'
        enabled: boolean
        fieldCount: number
        hostname: string
        counts: Partial<Record<Category, number>>
    }
}

export type GfMessageType = keyof GfMessageMap

/** Helper: assert at runtime that a payload has the expected `type`. */
export function isMessage<K extends GfMessageType>(msg: unknown, type: K): msg is GfMessageMap[K] {
    return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === type
}

/**
 * P1-8: true when a `runtime.onMessage` sender is THIS extension (not a web
 * page, not another extension). `runtime.onMessage` fires for any sender the
 * platform allows to reach it (including, per manifest config, other
 * extensions via `externally_connectable`) — a same-shaped payload from an
 * untrusted sender must never be allowed to trigger TRIGGER_CHECK /
 * GET_TAB_STATUS / REPHRASE_SELECTION handling. Every listener that acts on
 * a GfMessage MUST check this before dispatching on `type`.
 */
export function isTrustedSender(
    sender: { id?: string } | null | undefined,
    expectedExtensionId: string,
): boolean {
    return sender?.id === expectedExtensionId
}

/**
 * Build a typed sender for a specific message variant. The return type is
 * `(extra?) => GfMessageMap[K]` — callers don't need to write the
 * `{ type: '...' }` literal at every call site. The background, in turn,
 * only needs a tiny router that switches on the `type` field.
 */
export function messageSender<K extends GfMessageType>(type: K) {
    return (extra?: Omit<GfMessageMap[K], 'type'>): GfMessageMap[K] => {
        if (extra === undefined) {
            return { type } as GfMessageMap[K]
        }
        return { type, ...extra } as GfMessageMap[K]
    }
}

/**
 * Convenience: send a typed message to a specific tab. Wraps
 * `browser.tabs.sendMessage` so the caller doesn't have to cast through
 * `unknown`. The background uses this for the `commands` → `TRIGGER_CHECK`
 * routing; the popup uses it for the on-demand trigger button.
 */
export async function sendTabMessage<K extends GfMessageType>(
    tabId: number,
    payload: GfMessageMap[K],
): Promise<unknown> {
    return await browser.tabs.sendMessage(tabId, payload)
}

/** Convenience: send a typed message to the active tab (or null if none). */
export async function sendActiveTabMessage<K extends GfMessageType>(
    payload: GfMessageMap[K],
): Promise<unknown> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) return null
    return await browser.tabs.sendMessage(tab.id, payload)
}
