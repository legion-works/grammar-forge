// GrammarForge — Vencord userplugin entry. Lifecycle + settings only;
// all behaviour lives in orchestrator.ts (which reuses the browser
// client's layers). Built/bundled by clients/vencord/scripts/build.mjs
// in the grammar-forge repo.
import definePlugin, { OptionType } from '@utils/types'
import { definePluginSettings } from '@api/Settings'
import { ChatBarButtonMap } from '@api/ChatButtons'
import { startOrchestrator, type OrchestratorApi } from './orchestrator'
import { makeChatBarButton } from './chatbar'
import { resolveConfig } from './settings'

/** Move this plugin's chat-bar button to the FRONT of the Vencord button
 *  group (before Translate etc.). The map renders in insertion order and
 *  core registers our entry AFTER start() returns (PluginManager calls
 *  p.start() first, addChatBarButton a few lines later), so the reorder is
 *  deferred a tick. Re-inserting the other entries preserves their relative
 *  order. */
function moveChatBarButtonFirst(pluginName: string): void {
    setTimeout(() => {
        const own = ChatBarButtonMap.get(pluginName)
        if (!own) return
        const others = Array.from(ChatBarButtonMap.entries()).filter(([id]) => id !== pluginName)
        ChatBarButtonMap.clear()
        ChatBarButtonMap.set(pluginName, own)
        for (const [id, data] of others) ChatBarButtonMap.set(id, data)
    }, 0)
}

const settings = definePluginSettings({
    bridgeUrl: {
        type: OptionType.STRING,
        description: 'GrammarForge bridge URL (localhost needs no CSP setup)',
        default: 'http://localhost:8000',
    },
    allowRemoteBridge: {
        type: OptionType.BOOLEAN,
        description:
            'Allow a non-local bridge URL (privacy: your text is sent there; LAN/HTTPS hosts also need a Vencord CSP override + restart)',
        default: false,
    },
    realtimeDelayMs: {
        type: OptionType.NUMBER,
        description: 'Idle delay before checking (ms)',
        default: 500,
    },
    acceptHotkey: {
        type: OptionType.STRING,
        description: 'Hotkey that applies the first suggestion (e.g. ctrl+.)',
        default: 'ctrl+.',
    },
    rephraseHotkey: {
        type: OptionType.STRING,
        description:
            "Hotkey that rephrases the focused composer's selection (or the whole composer if nothing is selected)",
        default: 'ctrl+/',
    },
    checkPastedText: {
        type: OptionType.BOOLEAN,
        description: 'Also check pasted text (after a grace period)',
        default: false,
    },
    debugLogging: {
        type: OptionType.BOOLEAN,
        description: 'Verbose console logging ([GrammarForge] prefix) for debugging',
        default: false,
    },
    goals: {
        type: OptionType.CUSTOM,
        description:
            'Writing goals (audience + formality). Drives the muted-style filter and the default rephrase tone.',
        default: { audience: 'general', formality: 'neutral' },
    },
})

let orchestrator: OrchestratorApi | null = null

export default definePlugin({
    name: 'GrammarForge',
    description: 'Self-hosted grammar checking for the message composer (GrammarForge bridge)',
    authors: [{ name: 'GrammarForge', id: 0n }],
    settings,
    // The chat-bar slot needs a stable reference to the orchestrator at
    // RENDER time, but start() runs later (after plugin definition).
    // Module-level `api` indirection lets the chat-bar read the live ref
    // per event; before start() it returns null and the button renders
    // a zero-count idle state.
    chatBarButton: makeChatBarButton(() => orchestrator),
    start() {
        orchestrator = startOrchestrator(() => resolveConfig(settings.store))
        moveChatBarButtonFirst('GrammarForge')
    },
    stop() {
        orchestrator?.stop()
        orchestrator = null
    },
})
