// GrammarForge — Vencord userplugin entry. Lifecycle + settings only;
// all behaviour lives in orchestrator.ts (which reuses the browser
// client's layers). Built/bundled by clients/vencord/scripts/build.mjs
// in the grammar-forge repo.
import definePlugin, { OptionType } from '@utils/types'
import { definePluginSettings } from '@api/Settings'
import { startOrchestrator, type Orchestrator } from './orchestrator'
import { resolveConfig } from './settings'

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
    checkPastedText: {
        type: OptionType.BOOLEAN,
        description: 'Also check pasted text (after a grace period)',
        default: false,
    },
})

let orchestrator: Orchestrator | null = null

export default definePlugin({
    name: 'GrammarForge',
    description: 'Self-hosted grammar checking for the message composer (GrammarForge bridge)',
    authors: [{ name: 'GrammarForge', id: 0n }],
    settings,
    start() {
        orchestrator = startOrchestrator(() => resolveConfig(settings.store))
    },
    stop() {
        orchestrator?.stop()
        orchestrator = null
    },
})
