// Background service worker (MV3). Message router only — no business logic.
// Routes:
//   1. `commands.trigger-check`  →  forward TRIGGER_CHECK to the active tab
//   2. popup `GET_TAB_STATUS`    →  forward to the active tab; the content
//      script owns the truth (focused field, current counts) and replies
//      with TAB_STATUS. We don't synthesise the reply here.
// We keep a tiny explicit router so every flow is greppable.
import { isMessage, messageSender, type GfMessage, type GfMessageMap } from '@/messaging/schema'

export default defineBackground(() => {
    // (1) Browser commands: on-demand check.
    browser.commands.onCommand.addListener((command) => {
        if (command === 'trigger-check') {
            void sendToActiveTab(messageSender('TRIGGER_CHECK')())
        }
    })

    // (2) Popup → active tab: GET_TAB_STATUS. The content script's listener
    // returns a Promise<unknown>; we forward it back to the popup as the
    // message reply. Returning `true` (or a Promise) from the listener is
    // how WebExtensions keeps the response channel open.
    browser.runtime.onMessage.addListener((raw: unknown) => {
        if (!isMessage(raw, 'GET_TAB_STATUS')) return undefined
        return forwardGetTabStatusToActiveTab()
    })

    // Generic router — currently the only cross-cutting messages are
    // TRIGGER_CHECK (background → content) and GET_TAB_STATUS (popup → active
    // tab). Listed for documentation + future expansion.
    const _route = (msg: GfMessage): GfMessageMap[keyof GfMessageMap] | undefined => {
        if (isMessage(msg, 'TRIGGER_CHECK')) return undefined
        if (isMessage(msg, 'GET_TAB_STATUS')) return undefined
        if (isMessage(msg, 'TAB_STATUS')) return undefined
        return undefined
    }
    void _route
})

async function sendToActiveTab(message: GfMessageMap['TRIGGER_CHECK']): Promise<void> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) return
    try {
        await browser.tabs.sendMessage(tab.id, message)
    } catch (e) {
        // Common case: the active tab has no content script (chrome://,
        // about:, an extension page, the new-tab page). Swallow — there's
        // nothing to check.
        // oxlint-disable-next-line no-console
        console.debug('grammarforge: no content script on active tab', e)
    }
}

async function forwardGetTabStatusToActiveTab(): Promise<unknown> {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true })
    const tab = tabs[0]
    if (!tab?.id) {
        return {
            type: 'TAB_STATUS',
            enabled: false,
            fieldCount: 0,
            counts: {},
        }
    }
    try {
        const reply = await browser.tabs.sendMessage(tab.id, messageSender('GET_TAB_STATUS')())
        return reply
    } catch (e) {
        // No content script on this tab — return a benign empty status.
        // oxlint-disable-next-line no-console
        console.debug('grammarforge: GET_TAB_STATUS no content script', e)
        return {
            type: 'TAB_STATUS',
            enabled: false,
            fieldCount: 0,
            counts: {},
        }
    }
}
