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
import {
    showRephraseCard,
    showRephraseError,
    showRephrasePending,
    type RephraseCardHandle,
} from '@/overlay/rephrase-card'
import { debugWarn } from '@/lib/debug-log'
import { getSettings } from '@/storage/settings'
import { selectRephraseTarget, type RephraseSelection } from '@/hotkeys/rephrase-target'
import type { BridgeClient } from '@/api/client'

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
    ): Promise<void> => {
        const s = await getSettings()
        hideRephraseButton()
        const pending: RephraseCardHandle = showRephrasePending(deps.overlayRoot, {
            anchorRect: el.getBoundingClientRect(),
            onClose: () => {},
        })
        try {
            const res = await deps.client.rephrase({
                text,
                tone: s.rephraseTone || undefined,
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
                onApply: (chosen: string) => {
                    const live = getText(el)
                    if (live.slice(span.start, span.end) !== text) {
                        debugWarn('rephrase', 'selection span went stale; not applying')
                        return
                    }
                    void deps.applyEdit(el, span, chosen).then(() => {
                        deps.rerun(el, getText(el))
                    })
                },
                onClose: () => {},
            })
        } catch (e) {
            debugWarn('rephrase', 'rephrase failed', e)
            if (!deps.ctxIsValid()) return
            pending.hide()
            showRephraseError(deps.overlayRoot, {
                anchorRect: el.getBoundingClientRect(),
                message: 'Rephrase failed',
                onRetry: () => void openRephraseFor(el, text, span),
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
            rephraseButtonHandle = showRephraseButton(deps.overlayRoot, {
                anchorRect: found.rect,
                onClick: () => {
                    hideRephraseButton()
                    void openRephraseFor(found.el, found.text, found.span)
                },
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
