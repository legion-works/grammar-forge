// Rephrase flow for the content-script overlay: the selection debouncer
// (Rephrase button), the scope decision (selection-in-el vs whole-field),
// and the async bridge call (pending → result / error card). Pure parts
// (resolveRephraseScope, resolveSelection) are exported for unit tests.
// The orchestrator (content/index.ts) wires this module with a small
// RephraseDeps.
//
// Behavior is byte-equivalent to the previous inlined block — same
// per-el resolveSelection logic, same onSelectionChange debouncer, same
// openRephraseFor flow. The orchestrator no longer carries the rephrase
// code; it just owns the deps and the lifecycle push.

import { getSpanRectsBatch } from '@/overlay/rect'
import { getText } from '@/input/text'
import { selectionToCodeUnitSpan } from './index'
import { showRephraseButton, type RephraseButtonHandle } from '@/overlay/rephrase-button'
import { isSingleCleanWordSelection, type FlaggedRange, type ResolvedWord } from '@/overlay/synonyms'
import {
    dismissRephraseCardsIn,
    showRephraseCard,
    showRephraseError,
    showRephrasePending,
    type RephraseCardHandle,
    type RephraseTone,
} from '@/overlay/rephrase-card'
import type { RephraseScope as CardRephraseScope } from '@/overlay/rephrase-card'
import { debugWarn } from '@/lib/debug-log'
import { getSettings } from '@/storage/settings'
import { selectRephraseTarget, type RephraseSelection } from '@/hotkeys/rephrase-target'
import type { BridgeClient } from '@/api/client'
import type { Goals } from '@/api/types'
import { defaultToneFromGoals } from '@/lib/view-model'

export interface RephraseScope {
    el: HTMLElement
    text: string
    span: { start: number; end: number }
    rect: DOMRect
}

/** Resolve a single element's current non-empty selection into the rephrase
 *  scope (text + code-unit span + viewport rect). Returns null when there is
 *  no usable selection (collapsed, empty, whitespace-only, or not in the
 *  element). Identical semantics to the orchestrator's previous inlined
 *  `resolveSelection()` for a specific el. */
export function resolveSelection(el: HTMLElement): RephraseScope | null {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        if (end <= start) return null
        const text = el.value.slice(start, end)
        if (!text.trim()) return null
        const rects = getSpanRectsBatch(el, [{ start, end }])
        const rect = rects[0]?.[0] ?? el.getBoundingClientRect()
        return { el, text, span: { start, end }, rect }
    }
    const sel = el.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    if (!el.contains(range.commonAncestorContainer)) return null
    const span = selectionToCodeUnitSpan(el, range)
    const text = getText(el).slice(span.start, span.end)
    if (!text.trim()) return null
    const r = range.getBoundingClientRect()
    const rect = r.width || r.height ? r : el.getBoundingClientRect()
    return { el, text, span, rect }
}

/** Pure: given a `resolveSelection()` result and the target element, decide
 *  which text+span the rephrase should target. Selection matches the
 *  element → use it. Otherwise → whole field (empty/trim-only fields
 *  short-circuit to null so the caller can no-op). Delegates to the
 *  shared `selectRephraseTarget` so both DOM clients use the same
 *  decision. */
export function resolveRephraseScope(
    el: HTMLElement,
    found: RephraseScope | null,
    getWholeFieldText: (el: HTMLElement) => string = getText,
): { text: string; span: { start: number; end: number } } | null {
    return selectRephraseTarget({
        selection: found ? toSharedSelection(found) : null,
        currentEl: el,
        wholeText: () => getWholeFieldText(el),
    })
}

function toSharedSelection(scope: RephraseScope): RephraseSelection {
    return { el: scope.el, text: scope.text, span: scope.span }
}

export interface RephraseDeps {
    client: BridgeClient
    overlayRoot: ShadowRoot
    rerun: (el: HTMLElement, text: string) => void
    ctxIsValid: () => boolean
    /** Walk every tracked field; return the selection that matches one of them, or null. */
    resolveActiveSelection: () => RephraseScope | null
    /** Per-el applyEdit (the orchestrator's local closure that routes
     *  framework rich editors through the main-world agent). */
    applyEdit: (
        el: HTMLElement,
        span: { start: number; end: number },
        replacement: string,
    ) => Promise<void>
    /** Resolve the FOCUSED field's goals. W3-2: the rephrase default
     *  tone is seeded from `formality` (formal→'formal',
     *  informal→'casual', else→'neutral') so the W2b review panel's
     *  goals popover + the rephrase card's tone stay in sync. The
     *  orchestrator owns the per-field goals state; this callback is
     *  read at openRephraseFor time. Optional for back-compat (W1-4
     *  used `rephraseTone` only); when absent we fall back to the
     *  `rephraseTone` setting. */
    getGoals?: () => Goals | null
    /**
     * Feature 2 (interaction redesign): the ranges of currently-open
     * correction items on `el`, in code-unit `cuStart`/`cuEnd` form (the
     * shape already on `RenderableItem`). Used to gate the split control's
     * Synonyms segment — reused via `isSingleCleanWordSelection` from
     * @/overlay/synonyms, the same "clean word" predicate the removed
     * dblclick auto-open used. Optional; omitting it treats the field as
     * having no open corrections (Synonyms enablement then depends only on
     * the selection being a single word).
     */
    getFlaggedRanges?: (el: HTMLElement) => ReadonlyArray<FlaggedRange>
    /**
     * Open the Synonyms popover for a resolved word (fetch + measure +
     * show — mirrors the removed dblclick auto-open). Called when the user
     * clicks the split control's Synonyms segment. Optional; when omitted
     * the Synonyms segment renders but is inert (defensive — every real
     * wiring supplies this).
     */
    openSynonyms?: (el: HTMLElement, resolved: ResolvedWord) => void
}

export interface RephraseFlow {
    /** The pill's onRephrase handler — invokes the rephrase flow for a
     *  specific element (selection-in-el when available, else whole field). */
    rephraseFor: (el: HTMLElement) => void
    /** Hide the Rephrase button (URL change, etc.) without releasing the
     *  selectionchange listener. */
    dismissButton: () => void
    /** Release the selectionchange listener and the Rephrase button. */
    stop: () => void
}

export function mountRephraseFlow(deps: RephraseDeps): RephraseFlow {
    let rephraseButtonHandle: RephraseButtonHandle | null = null
    const hideRephraseButton = (): void => {
        rephraseButtonHandle?.hide()
        rephraseButtonHandle = null
    }

    const openRephraseFor = async (
        el: HTMLElement,
        text: string,
        span: { start: number; end: number },
        /** Re-issue path: when provided, the user toggled scope/tone on
         *  the existing card and we re-issue with the new state. When
         *  absent (initial open), we seed scope='sentence' and tone
         *  from the focused field's goals. */
        reissueState: { scope: CardRephraseScope; tone: RephraseTone } | null = null,
    ): Promise<void> => {
        const s = await getSettings()
        // W3-2: seed the rephrase default tone from the FOCUSED field's
        // goals. `formality === 'formal'` → 'formal', `informal` → 'casual',
        // else → 'neutral'. Falls back to the `rephraseTone` setting when
        // the orchestrator didn't supply a `getGoals` (W1-4 back-compat).
        const goals = deps.getGoals?.() ?? null
        const goalTone = goals ? defaultToneFromGoals(goals) : null
        const rephraseToneRaw = reissueState?.tone ?? goalTone ?? s.rephraseTone
        const rephraseTone: 'neutral' | 'formal' | 'casual' =
            rephraseToneRaw === 'formal' || rephraseToneRaw === 'casual'
                ? rephraseToneRaw
                : 'neutral'
        const scope: CardRephraseScope = reissueState?.scope ?? 'sentence'
        hideRephraseButton()
        const pending: RephraseCardHandle = showRephrasePending(deps.overlayRoot, {
            anchorRect: el.getBoundingClientRect(),
            onClose: () => {},
        })
        try {
            const res = await deps.client.rephrase({
                text,
                tone: rephraseTone,
                style: s.rephraseStyle || undefined,
                alternatives: s.rephraseAlternatives,
                source: 'browser',
                override: s.rephraseOverride,
            })
            if (!deps.ctxIsValid()) return
            pending.hide()
            showRephraseCard(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                original: res.original,
                rephrased: res.rephrased,
                alternatives: res.alternatives,
                scope,
                tone: rephraseTone,
                onAccept: (chosen: string) => {
                    // Close the card immediately on accept so the user
                    // sees the result applied without the card lingering.
                    dismissRephraseCardsIn(deps.overlayRoot)
                    const live = getText(el)
                    if (live.slice(span.start, span.end) !== text) {
                        debugWarn('rephrase', 'selection span went stale; not applying')
                        return
                    }
                    void deps.applyEdit(el, span, chosen).then(() => {
                        deps.rerun(el, getText(el))
                    })
                },
                onClose: () => { dismissRephraseCardsIn(deps.overlayRoot) },
                onScopeChange: (nextScope) => {
                    // W3-1: re-issue the bridge call with the new scope,
                    // the same text/span/tone, and replace the card via
                    // pending → result. The re-issue path (via
                    // reissueState) preserves the user's current scope
                    // and tone across calls.
                    void openRephraseFor(el, text, span, { scope: nextScope, tone: rephraseTone })
                },
                onToneChange: (nextTone) => {
                    void openRephraseFor(el, text, span, { scope, tone: nextTone })
                },
                onRegenerate: () => {
                    void openRephraseFor(el, text, span, { scope, tone: rephraseTone })
                },
                modelLabel: 'Gemma',
            })
        } catch (e) {
            debugWarn('rephrase', 'rephrase failed', e)
            if (!deps.ctxIsValid()) return
            pending.hide()
            showRephraseError(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                message: 'Rephrase failed',
                onRetry: () => void openRephraseFor(el, text, span, reissueState),
                onClose: () => {},
            })
        }
    }

    const rephraseFor = (el: HTMLElement): void => {
        const found = resolveSelection(el)
        const scope = resolveRephraseScope(el, found)
        if (!scope) return
        void openRephraseFor(el, scope.text, scope.span)
    }

    let selectionDebounce: ReturnType<typeof setTimeout> | null = null
    const onSelectionChange = (): void => {
        if (selectionDebounce) clearTimeout(selectionDebounce)
        selectionDebounce = setTimeout(() => {
            selectionDebounce = null
            const found = deps.resolveActiveSelection()
            if (!found) {
                hideRephraseButton()
                return
            }
            // Feature 2b: gate the split control's Synonyms segment on the
            // selection being a single "clean" word — same predicate the
            // removed dblclick auto-open used, now driven off the current
            // selection instead of a click point. A double-click selects
            // its word natively, so this selectionchange path also covers
            // the old dblclick-to-synonyms gesture (Feature 2c).
            const fullText = getText(found.el)
            const flagged = deps.getFlaggedRanges?.(found.el) ?? []
            const cleanWord = isSingleCleanWordSelection(fullText, found.span, flagged)
            rephraseButtonHandle = showRephraseButton(deps.overlayRoot, {
                anchorRect: found.rect,
                onClick: () => {
                    hideRephraseButton()
                    void openRephraseFor(found.el, found.text, found.span)
                },
                synonymsEnabled: cleanWord !== null,
                synonymsDisabledReason: cleanWord
                    ? undefined
                    : 'Select a single word without an active correction to see synonyms',
                onSynonymsClick: cleanWord
                    ? () => {
                          hideRephraseButton()
                          deps.openSynonyms?.(found.el, cleanWord)
                      }
                    : undefined,
            })
        }, 150)
    }
    document.addEventListener('selectionchange', onSelectionChange)

    return {
        rephraseFor,
        dismissButton: hideRephraseButton,
        stop: () => {
            document.removeEventListener('selectionchange', onSelectionChange)
            if (selectionDebounce) clearTimeout(selectionDebounce)
            hideRephraseButton()
        },
    }
}
