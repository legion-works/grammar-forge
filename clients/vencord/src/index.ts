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
 *  order.
 *
 *  P2-8 CAUTION — this reorder is a hack, not a documented Vencord API:
 *  it clear()s + reinserts Vencord-core's own `ChatBarButtonMap`
 *  (@api/ChatButtons), relying on undocumented, currently-observed core
 *  behaviour (core registers a plugin's chatBarButton via addChatBarButton
 *  strictly AFTER that plugin's start() returns, and the map iterates in
 *  insertion order). Neither of those is a stated contract. Two ways this
 *  can silently break:
 *    1. Another plugin does the exact same clear()+reinsert trick in its
 *       own start() — whichever plugin's setTimeout(0) callback runs LAST
 *       wins the front slot, and the "winner" can flip release to release
 *       depending on plugin load order (a race, not a guarantee).
 *    2. A future Vencord core version changes WHEN addChatBarButton runs
 *       relative to start() (e.g. moves it before start(), or batches
 *       registration), or changes ChatBarButtonMap to a structure that
 *       doesn't preserve insertion order — this function would then either
 *       no-op (own() lookup finds nothing yet) or silently stop reordering
 *       anything, with no error surfaced.
 *  No behavior change here — this is a caution comment only. If the chat-
 *  bar button's position starts drifting after a Vencord update or another
 *  plugin installs, THIS function's assumptions are the first place to
 *  check. */
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
            "Hotkey that rephrases the focused composer's selection (or the whole composer if nothing is selected). " +
            'Default is ctrl+shift+/ — plain ctrl+/ collides with Discord’s built-in keyboard-shortcuts overlay ' +
            '(this plugin’s capture-phase handler would swallow it before Discord sees the chord).',
        default: 'ctrl+shift+/',
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
        orchestrator = startOrchestrator(
            () => resolveConfig(settings.store),
            (next) => {
                // P0-1: resolveConfig(settings.store) returns a brand-new
                // GrammarForgeConfig object on every call (settings.ts) —
                // mutating `getConfig().goals` is a no-op that silently
                // discarded the user's goals change. Write through to the
                // actual persisted settings store instead so every later
                // resolveConfig() call picks it up.
                settings.store.goals = next
            },
        )
        moveChatBarButtonFirst('GrammarForge')
    },
    stop() {
        orchestrator?.stop()
        orchestrator = null
    },
})
