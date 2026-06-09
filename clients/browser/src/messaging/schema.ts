// Typed contracts for messages between the background service worker and
// content scripts. Tiny on purpose — there's exactly one command the
// background ever needs to send (the on-demand check trigger) and the
// future-proofing is mostly about discrimination + a small set of "from
// content" replies the popup/options can ask for (e.g. "what's the current
// per-tab status?"). The background remains a router — it never inspects
// payloads beyond the type tag.

import type { Category } from '@/api/types'

/** Discriminated union of every message that may cross the boundary. */
export type GfMessage =
    | { type: 'TRIGGER_CHECK' }
    | { type: 'GET_TAB_STATUS' }
    | {
          type: 'TAB_STATUS'
          enabled: boolean
          fieldCount: number
          /** Per-category counts on the FOCUSED field's last check, if any. */
          counts: Partial<Record<Category, number>>
      }

/** Map of message type tag → full payload, for type-safe senders. */
export interface GfMessageMap {
    TRIGGER_CHECK: { type: 'TRIGGER_CHECK' }
    GET_TAB_STATUS: { type: 'GET_TAB_STATUS' }
    TAB_STATUS: {
        type: 'TAB_STATUS'
        enabled: boolean
        fieldCount: number
        counts: Partial<Record<Category, number>>
    }
}

export type GfMessageType = keyof GfMessageMap

/** Helper: assert at runtime that a payload has the expected `type`. */
export function isMessage<K extends GfMessageType>(msg: unknown, type: K): msg is GfMessageMap[K] {
    return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === type
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
