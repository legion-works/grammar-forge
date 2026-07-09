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
import {
    showRephraseCard,
    showRephraseError,
    showRephrasePending,
    type RephraseScope as CardRephraseScope,
    type RephraseTone,
} from '@/overlay/rephrase-card'
import { showToast } from '@/overlay/toast'
import { selectRephraseTarget, type RephraseSelection } from '@/hotkeys/rephrase-target'

export interface RephraseScope {
    el: HTMLElement
    text: string
    span: { start: number; end: number }
}

export function resolveRephraseScope(
    target: HTMLElement,
    found: RephraseScope | null,
): RephraseScope | null {
    // Delegate to the shared `selectRephraseTarget` so both DOM clients
    // use the same decision. `wholeText` is a thunk so the selection-match
    // fast path doesn't pay the whole-field read cost.
    const out = selectRephraseTarget({
        selection: found ? toSharedSelection(found) : null,
        currentEl: target,
        wholeText: () => getText(target),
    })
    if (!out) return null
    return { el: target, text: out.text, span: out.span }
}

function toSharedSelection(scope: RephraseScope): RephraseSelection {
    return { el: scope.el, text: scope.text, span: scope.span }
}

export interface RephraseDeps {
    client: () => BridgeClient
    overlayRoot: ShadowRoot
    debugLog: ApplyTraceLogger
    /** W3-3: tone seed from the user's goals (formal→'formal',
     *  informal→'casual', neutral→'neutral'). The card lets the user
     *  override per-request; this is the initial value. Optional for
     *  back-compat with callers that pre-date the goals setting
     *  (defaults to 'neutral'). */
    defaultTone?: () => 'neutral' | 'formal' | 'casual'
}

/** Re-issue state carried across scope/tone toggles and the Regenerate
 *  button: same text/span (mirrors the browser client — scope is a card
 *  affordance, not a distinct re-extraction, in both clients today), but
 *  the CURRENT tone/scope so a re-open reflects the user's latest choice
 *  and so `tone` actually reaches the bridge (the original vencord
 *  implementation seeded the card's tone from goals but never sent it in
 *  the request — Formal/Casual taps were cosmetic only). */
interface RephraseReissue {
    scope: CardRephraseScope
    tone: RephraseTone
}

export function openRephraseFor(
    el: HTMLElement,
    text: string,
    span: { start: number; end: number },
    deps: RephraseDeps,
    onAfterApply: () => void,
    reissue: RephraseReissue | null = null,
): Promise<void> {
    deps.debugLog('rephrase start', { textLen: text.length, span, reissue })
    const pending = showRephrasePending(deps.overlayRoot, {
        anchorRect: el.getBoundingClientRect(),
        onClose: () => {},
    })
    // W3-3: use the goals-seeded default tone (formal/informal/neutral
    // → formal/casual/neutral) for the card's initial value; a reissue
    // (scope/tone toggle, Regenerate) carries the user's latest choice.
    const tone: RephraseTone = reissue?.tone ?? deps.defaultTone?.() ?? 'neutral'
    const scope: CardRephraseScope = reissue?.scope ?? 'sentence'
    return deps
        .client()
        .rephrase({ text, tone, source: 'vencord' })
        .then((res) => {
            pending.hide()
            showRephraseCard(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                original: res.original,
                rephrased: res.rephrased,
                alternatives: res.alternatives,
                scope,
                tone,
                onAccept: (chosen: string) => {
                    const live = getText(el)
                    if (live.slice(span.start, span.end) !== text) {
                        deps.debugLog('rephrase stale span; not applying')
                        return
                    }
                    void applySlateFix(el, span, chosen, deps.debugLog).then((applied) => {
                        if (applied) {
                            // W3-3: every rephrase-accept gets an Undo toast.
                            // The Undo re-applies the previous text — the
                            // simplest path is to record an inverse edit
                            // and route through planUndo (mirrors
                            // applyItem's pattern).
                            showToast(deps.overlayRoot, {
                                message: 'Rephrased',
                                actionLabel: 'Undo',
                                onAction: () => {
                                    void applySlateFix(
                                        el,
                                        span,
                                        text,
                                        deps.debugLog,
                                    ).then(() => onAfterApply())
                                },
                            })
                        }
                        onAfterApply()
                    })
                },
                onClose: () => {},
                // Scope/tone toggles and Regenerate all re-issue the bridge
                // call (previously these only logged — Formal/Casual/
                // Regenerate were dead buttons in the Vencord card).
                onScopeChange: (nextScope) =>
                    void openRephraseFor(el, text, span, deps, onAfterApply, {
                        scope: nextScope,
                        tone,
                    }),
                onToneChange: (nextTone) =>
                    void openRephraseFor(el, text, span, deps, onAfterApply, {
                        scope,
                        tone: nextTone,
                    }),
                onRegenerate: () =>
                    void openRephraseFor(el, text, span, deps, onAfterApply, { scope, tone }),
                modelLabel: 'Gemma',
            })
            deps.debugLog('rephrase done', { alternatives: res.alternatives.length })
        })
        .catch((e) => {
            deps.debugLog('rephrase failed', e)
            pending.hide()
            showRephraseError(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                message: 'Rephrase failed',
                onRetry: () => void openRephraseFor(el, text, span, deps, onAfterApply, reissue),
                onClose: () => {},
            })
        })
}
