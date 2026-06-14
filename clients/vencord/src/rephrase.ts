// Rephrase flow for the Vencord Discord composer. Two pieces:
//   - resolveRephraseScope: pure decision — selection-in-composer or
//     whole-field. Tested in isolation.
//   - openRephraseFor: async bridge call → pending card → result /
//     error card. Closure over the orchestrator's deps.
//
// Mirrors clients/browser/src/entrypoints/content/rephrase.ts (the
// Vencord version is simpler — no separate Rephrase-button debouncer,
// the hotkey/key chord directly opens the rephrase).
//
// Debug logging: the orchestrator owns a variadic `debugLog` (gated on
// the plugin's debugLogging setting); it's passed in via RephraseDeps
// so the module can stay plugin-agnostic.

import { getText } from '@/input/text'
import { applySlateFix, type ApplyTraceLogger } from '@/input/rich-editor-apply'
import type { BridgeClient } from '@/api/client'
import { showRephraseCard, showRephraseError, showRephrasePending } from '@/overlay/rephrase-card'

export interface RephraseScope {
    el: HTMLElement
    text: string
    span: { start: number; end: number }
}

export function resolveRephraseScope(
    target: HTMLElement,
    found: RephraseScope | null,
): RephraseScope | null {
    if (found && found.el === target) return found
    const text = getText(target)
    if (!text.trim()) return null
    return { el: target, text, span: { start: 0, end: text.length } }
}

export interface RephraseDeps {
    client: () => BridgeClient
    overlayRoot: ShadowRoot
    debugLog: ApplyTraceLogger
}

export function openRephraseFor(
    el: HTMLElement,
    text: string,
    span: { start: number; end: number },
    deps: RephraseDeps,
    onAfterApply: () => void,
): Promise<void> {
    deps.debugLog('rephrase start', { textLen: text.length, span })
    const pending = showRephrasePending(deps.overlayRoot, {
        anchorRect: el.getBoundingClientRect(),
        onClose: () => {},
    })
    return deps
        .client()
        .rephrase({ text, source: 'vencord' })
        .then((res) => {
            pending.hide()
            showRephraseCard(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                original: res.original,
                rephrased: res.rephrased,
                alternatives: res.alternatives,
                onApply: (chosen: string) => {
                    const live = getText(el)
                    if (live.slice(span.start, span.end) !== text) {
                        deps.debugLog('rephrase stale span; not applying')
                        return
                    }
                    void applySlateFix(el, span, chosen, deps.debugLog).then(() => onAfterApply())
                },
                onClose: () => {},
            })
            deps.debugLog('rephrase done', { alternatives: res.alternatives.length })
        })
        .catch((e) => {
            deps.debugLog('rephrase failed', e)
            pending.hide()
            showRephraseError(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                message: 'Rephrase failed',
                onRetry: () => void openRephraseFor(el, text, span, deps, onAfterApply),
                onClose: () => {},
            })
        })
}
