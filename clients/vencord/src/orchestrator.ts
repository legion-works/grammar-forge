// Vencord orchestrator: the SOLE wirer for the Discord composer, composing
// the browser client's battle-tested layers (attachment/debounce, pipeline,
// overlay, popover, signal queue, status pill, rephrase card, dictionary).
// Mirrors clients/browser entrypoints/content/index.ts, adapted to Discord's
// contenteditable composer (no textarea/input branch, beforeinput-driven
// check, capture-phase paste fallback). All teardown handles are collected so
// stop() restores Discord to its unmonitored state.
import { createFieldObserver } from '@/input/observer'
import { createFieldAttachment, type FieldAttachment } from '@/input/attachment'
import { isPasteInput, shouldCheckInput } from '@/input/paste-guard'
import { applyFix, domPointToFlatOffset, getText } from '@/input/text'
import {
    buildRenderableItems,
    isSpanStillValid,
    tallyByCategory,
    type RenderableItem,
} from '@/lib/pipeline'
import { appendInverseEdit, planUndo, type InverseEdit } from '@/lib/undo'
import { BridgeClient } from '@/api/client'
import { createSignalQueue } from '@/signal/queue'
import { createOverlayHost } from '@/overlay/shadow-host'
import { getSpanRectsBatch } from '@/overlay/rect'
import { createHighlightLayer, type HighlightLayer, type HighlightSpec } from '@/overlay/highlight'
import { showPopover, dismissPopoversIn, type PopoverHandle } from '@/overlay/popover'
import {
    renderStatusButton,
    type PillCorrection,
    type StatusButtonHandle,
    type StatusButtonOptions,
} from '@/overlay/status-button'
import {
    dismissRephraseCardsIn,
    showRephraseCard,
    showRephraseError,
    showRephrasePending,
} from '@/overlay/rephrase-card'
import { showToast } from '@/overlay/toast'
import { shouldAcceptHotkey } from '@/hotkeys/accept'
import { isDiscordComposer } from './composer'
import type { GrammarForgeConfig } from './settings'

// Fixed paste-grace window for v1. After a paste/drop, the immediate check is
// suppressed for this many ms so the user can edit the pasted text before
// GrammarForge flags it.
const PASTE_GRACE_MS = 1500

export type InputDecision = 'check' | 'skip' | 'grace'

/** Compact, log-safe description of the current selection RELATIVE to a
 *  composer element: flat code-unit offsets when resolvable (the same model
 *  applyFix uses), else the raw container/offset pair. Debug-logging only. */
function selectionDebugInfo(el: HTMLElement): unknown {
    const sel = el.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0) return 'no-selection'
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return 'outside-composer'
    const start = domPointToFlatOffset(el, range.startContainer, range.startOffset)
    const end = domPointToFlatOffset(el, range.endContainer, range.endOffset)
    return { start, end, collapsed: range.collapsed }
}

/** Pure input-event policy: typing checks; pastes skip (default) or defer
 *  to a grace window (checkPastedText on). */
export function inputGate(inputType: string, opts: { checkPastedText: boolean }): InputDecision {
    if (isPasteInput(inputType)) return opts.checkPastedText ? 'grace' : 'skip'
    return shouldCheckInput(inputType, { checkPastedText: true }) ? 'check' : 'skip'
}

/** Pure: given a contenteditable selection's two endpoint offsets (or null
 *  when domPointToFlatOffset couldn't resolve one), return the
 *  applyFix-shaped code-unit span. An unresolvable / inverted endpoint
 *  yields a collapsed {0,0}, which every caller discards as empty. A
 *  collapsed-but-valid selection (start === end) is returned verbatim so
 *  the caller can drop it via its own text-trim check. */
export function resolveSelectionSpan(
    start: number | null,
    end: number | null,
): { start: number; end: number } {
    if (start == null || end == null || end < start) return { start: 0, end: 0 }
    return { start, end }
}

interface FieldState {
    attachment: FieldAttachment
    items: RenderableItem[]
    itemRects: Array<{ item: RenderableItem; rects: DOMRect[] }>
    checkSeq: number
    pasteGraceTimer: ReturnType<typeof setTimeout> | null
    highlightLayer: HighlightLayer | null
    /** Last apply action's inverse edits (single undo slot; a new apply
     *  overwrites it, undo consumes it). null = nothing to undo. Per-field
     *  so a settings-driven teardown doesn't lose it and different fields
     *  don't share an undo queue. */
    lastApplied: InverseEdit[] | null
}

export interface OrchestratorApi {
    /** Tear down every listener, field, overlay, signal queue, and pill. */
    stop: () => void
    /** Live summary of the ACTIVE composer (focused → last-active → zeros).
     *  Used by an external status surface (e.g. a Vencord toolbar badge). */
    getSummary: () => {
        count: number
        byCategory: Partial<Record<string, number>>
        paused: boolean
    }
    /** Subscribe to every render / pause-toggle / attach-detach event. The
     *  callback is invoked synchronously; unsubscribe via the returned fn. */
    subscribe: (cb: () => void) => () => void
    /** Show the status pill anchored to the supplied rect (typically the
     *  field's bounding rect). Mounts the pill if not yet mounted. */
    showPill: (anchorRect: DOMRect) => void
    /** Hide the status pill. No-op while its hover panel is open. */
    hidePill: () => void
    /** Toggle the pill's hover panel (showPill if hidden, then open/close). */
    togglePanel: (anchorRect: DOMRect) => void
    /** Toggle the runtime-wide pause. While paused: onInputEvent returns
     *  false, rerunFor is a no-op, every field's items are cleared and
     *  popovers closed; on resume, the focused composer is re-checked. */
    togglePause: () => void
}

/** Back-compat alias. Older callers (and the v1 plugin entry) reference
 *  `Orchestrator`; keep the name alive so they keep compiling. */
export type Orchestrator = OrchestratorApi

interface ItemRectHit {
    item: RenderableItem
    rect: DOMRect
    index: number
}

function hitTest(
    itemRects: ReadonlyArray<{ item: RenderableItem; rects: DOMRect[] }>,
    x: number,
    y: number,
): ItemRectHit | null {
    for (let i = 0; i < itemRects.length; i++) {
        const entry = itemRects[i]!
        for (const r of entry.rects) {
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                return { item: entry.item, rect: r, index: i }
            }
        }
    }
    return null
}

export function startOrchestrator(getConfig: () => GrammarForgeConfig): OrchestratorApi {
    // Debug logger gated on the plugin's debugLogging setting (read live).
    // localStorage does NOT exist in the Discord renderer, so the browser
    // client's gfDebug toggle is unusable here — the setting is the switch.
    // oxlint-disable-next-line no-console
    const debugLog = (...args: unknown[]): void => {
        if (getConfig().debugLogging) console.log('[GrammarForge]', ...args)
    }
    // Client rebuilds when bridgeUrl/allowRemoteBridge change (settings are
    // live). All other config flags (realtimeDelayMs, checkPastedText,
    // acceptHotkey) are read live by reference.
    const cfg0 = getConfig()
    let client = new BridgeClient(cfg0.bridgeUrl, cfg0.allowRemoteBridge)
    let clientKey = cfg0.bridgeUrl + '|' + cfg0.allowRemoteBridge
    const refreshClient = (): BridgeClient => {
        const c = getConfig()
        const key = c.bridgeUrl + '|' + c.allowRemoteBridge
        if (key !== clientKey) {
            client = new BridgeClient(c.bridgeUrl, c.allowRemoteBridge)
            clientKey = key
        }
        return client
    }
    const signalQueue = createSignalQueue({
        send: (events) => refreshClient().signal(events),
    })
    const overlay = createOverlayHost()
    const fields = new Map<HTMLElement, FieldState>()
    const trackedFields = new Set<HTMLElement>()
    const openPopovers = new WeakMap<HTMLElement, PopoverHandle>()
    const cleanups: Array<() => void> = []
    // Module state for the runtime-wide pause + the pill surface.
    let paused = false
    const subscribers = new Set<() => void>()
    const notify = (): void => {
        for (const cb of subscribers) {
            try {
                cb()
            } catch {
                // A bad subscriber must not break the rest of the notify
                // fanout (and must not break the orchestrator's main path).
            }
        }
    }
    let pillHandle: StatusButtonHandle | null = null
    let pillAnchor: DOMRect | null = null
    let panelOpen = false
    let lastActiveField: HTMLElement | null = null

    const clearPasteGrace = (st: FieldState): void => {
        if (st.pasteGraceTimer != null) {
            clearTimeout(st.pasteGraceTimer)
            st.pasteGraceTimer = null
        }
    }

    // Resolve the composer the pill should summarise / be anchored to.
    // Focused tracked field → most-recently-tracked field → null (zeros).
    const activeComposer = (): HTMLElement | null => {
        const focused = focusedTrackedField()
        if (focused) return focused
        return lastActiveField
    }

    const renderField = (el: HTMLElement, st: FieldState): void => {
        st.itemRects = []
        if (st.items.length === 0) {
            st.highlightLayer?.reconcile([])
            // A cleared field is no longer "last-active" unless the user is
            // still on it (zero items just means no suggestions).
            if (lastActiveField === el && document.activeElement !== el) {
                lastActiveField = null
            }
            // Refresh the pill (count → 0) if mounted + visible. Skipped
            // while a panel is open — the next open rebuilds fresh.
            if (pillHandle && pillHandle.isMounted() && !panelOpen) {
                pillHandle.update(buildPillOptions(el, st))
            }
            notify()
            return
        }
        // Highlight/hit-test the WORD range (hlStart/hlEnd), not the raw edit
        // span — a zero-width insertion (e.g. "sw"->"saw") has no rect.
        const spans = st.items.map((it) => ({ start: it.hlStart, end: it.hlEnd }))
        let allRects: DOMRect[][]
        try {
            allRects = getSpanRectsBatch(el, spans)
        } catch {
            // Measurement failed (detached node / odd layout) — leave
            // stale rects + highlights in place; the next remeasure or
            // re-render will fix it.
            return
        }
        if (allRects.length === 0) return
        st.itemRects = st.items.map((it, i) => ({ item: it, rects: allRects[i] ?? [] }))
        if (!st.highlightLayer) st.highlightLayer = createHighlightLayer(overlay.root)
        const specs: HighlightSpec[] = []
        for (let i = 0; i < st.items.length; i++) {
            const item = st.items[i]!
            for (const rect of allRects[i] ?? []) {
                specs.push({ rect, category: item.category, itemIndex: i })
            }
        }
        st.highlightLayer.reconcile(specs)
        st.highlightLayer.setState({
            focused: document.activeElement === el,
            hoverItemIndex: null,
        })
        // Refresh the pill if mounted + visible. Skipped while a panel is
        // open — the pill's update() closes the panel by design (acceptable;
        // the next open rebuilds with fresh data).
        if (pillHandle && pillHandle.isMounted() && !panelOpen) {
            pillHandle.update(buildPillOptions(el, st))
        }
        notify()
    }

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const st = fields.get(el)
            if (!st) return
            if (paused) return
            if (!el.isConnected) {
                st.items = []
                renderField(el, st)
                return
            }
            const seq = ++st.checkSeq
            debugLog('check start', { seq, textLen: text.length })
            try {
                const res = await refreshClient().correct({ text, source: 'vencord' })
                if (seq !== st.checkSeq) return
                st.items = buildRenderableItems(text, res).items
                debugLog('check done', { seq, items: st.items.length })
                renderField(el, st)
            } catch (e) {
                // Bridge unreachable: silent idle, no intrusive toast in v1.
                debugLog('check failed', e)
            }
        }

    // Apply an item's PRIMARY replacement, stale-guarded. Records the
    // inverse edit on the field's undo slot and emits the accepted signal.
    // Returns false (no-op) when the span has gone stale.
    const applyItem = (el: HTMLElement, item: RenderableItem): boolean => {
        const st = fields.get(el)
        if (!st) return false
        if (!isSpanStillValid(getText(el), item)) {
            void rerunFor(el)(getText(el))
            return false
        }
        const replacement = item.replacements[0] ?? ''
        applyFix(el, { start: item.cuStart, end: item.cuEnd }, replacement)
        // Record the inverse edit (single-level slot: a new apply overwrites
        // the prior).
        st.lastApplied = appendInverseEdit([], {
            start: item.cuStart,
            end: item.cuEnd,
            replacement,
            original: item.original,
        })
        signalQueue.enqueue({
            id: item.id,
            action: 'accepted',
            category: item.category,
            source: 'vencord',
        })
        void rerunFor(el)(getText(el))
        return true
    }

    // Pill panel: apply ONE correction by index, then re-check.
    const applyOneFor = (el: HTMLElement, index: number): void => {
        const st = fields.get(el)
        const item = st?.items[index]
        if (!item) return
        closePopoverFor(el)
        applyItem(el, item)
    }

    // Add the flagged word(s) to the user dictionary: persist on the bridge,
    // log a rejected signal for the edit, re-check (the suggestion
    // disappears), and offer Undo. The LLM can merge two adjacent unknown
    // words into ONE edit, so a multi-token original is split and each
    // token added. Bridge-unreachable failures are debugLog'd only.
    const addWordToDictionary = async (
        el: HTMLElement,
        item: RenderableItem,
        word: string,
    ): Promise<void> => {
        const tokens = [...new Set(word.split(/\s+/).filter((t) => t.length > 0))]
        if (tokens.length === 0) return
        const c = refreshClient()
        try {
            await Promise.all(tokens.map((t) => c.dictionaryAdd(t)))
        } catch (e) {
            debugLog('dictionary add failed', e)
            return
        }
        signalQueue.enqueue({
            id: item.id,
            action: 'rejected',
            category: item.category,
            source: 'vencord',
        })
        debugLog('dictionary add', { tokens, itemId: item.id })
        void rerunFor(el)(getText(el))
        const label =
            tokens.length === 1
                ? `Added "${tokens[0]}" to dictionary`
                : `Added ${tokens.length} words to dictionary`
        showToast(overlay.root, {
            message: label,
            actionLabel: 'Undo',
            onAction: () => {
                Promise.all(tokens.map((t) => c.dictionaryRemove(t)))
                    .then(() => rerunFor(el)(getText(el)))
                    .catch((e) => debugLog('dictionary undo remove failed', e))
            },
        })
    }

    // Pill panel: apply ALL corrections. Apply them ONE AT A TIME, last-to-
    // first so earlier offsets stay valid — but YIELD A FRAME between edits
    // so Discord's Slate reconciler syncs before the next applyFix reads the
    // live text. Each item is re-validated against the live text; signals
    // deduped by correction id. The inverse edits build a single batch
    // committed to lastApplied on success.
    const applyAllFor = async (el: HTMLElement): Promise<void> => {
        const st = fields.get(el)
        if (!st) return
        closePopoverFor(el)
        const ordered = [...st.items].sort((a, b) => b.cuStart - a.cuStart)
        const signaled = new Set<number>()
        let batch: InverseEdit[] = []
        for (const item of ordered) {
            if (!el.isConnected) return
            if (!isSpanStillValid(getText(el), item)) continue
            const replacement = item.replacements[0] ?? ''
            applyFix(el, { start: item.cuStart, end: item.cuEnd }, replacement)
            batch = appendInverseEdit(batch, {
                start: item.cuStart,
                end: item.cuEnd,
                replacement,
                original: item.original,
            })
            if (typeof item.id === 'number' && item.id > 0 && !signaled.has(item.id)) {
                signaled.add(item.id)
                signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'vencord',
                })
            }
            // Let Slate reconcile so the next isSpanStillValid reads fresh
            // text and the next applyFix lands cleanly.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (batch.length > 0) st.lastApplied = batch
        if (!el.isConnected) return
        debugLog('apply all', { count: batch.length })
        void rerunFor(el)(getText(el))
    }

    // Undo the field's last apply action: re-apply the recorded inverse
    // edits highest-first, stale-guarded against the live text, then
    // re-check. The accept signals already sent are NOT compensated
    // (client-side restore only — mirrors the Ignore-Undo semantics).
    const undoFor = async (el: HTMLElement): Promise<void> => {
        const st = fields.get(el)
        if (!st?.lastApplied?.length) return
        const ops = planUndo(getText(el), st.lastApplied)
        // Clear first so a mid-undo failure doesn't double-restore.
        st.lastApplied = null
        for (const op of ops) {
            if (!el.isConnected) return
            applyFix(el, op.span, op.replacement)
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        debugLog('undo', { ops: ops.length })
        // Refresh the pill so the Undo button flips back to disabled.
        renderField(el, st)
        void rerunFor(el)(getText(el))
    }

    const closePopoverFor = (el: HTMLElement): void => {
        openPopovers.get(el)?.hide()
        openPopovers.delete(el)
    }

    const openPopoverFor = (el: HTMLElement, item: RenderableItem, anchorRect: DOMRect): void => {
        debugLog('popover open', {
            original: item.diffOriginal,
            category: item.category,
            activeBefore: document.activeElement?.tagName,
        })
        // Single-popover invariant: dismiss any prior popover for this field
        // before opening a new one.
        closePopoverFor(el)
        const handle = showPopover(overlay.root, {
            anchorRect,
            category: item.category,
            message: item.message,
            diffOriginal: item.diffOriginal,
            diffCorrected: item.diffCorrected,
            diffIsDeletion: item.diffIsDeletion,
            replacements: item.replacements,
            // Add-to-dictionary (spelling only) feeds on the WORD-RANGE text
            // (diffOriginal — what the popover shows struck through), NOT
            // item.original: the minimal edit span trims the diff's common
            // prefix/suffix, so e.g. a shared-prefix/suffix rewrite has
            // mangled-fragment item.original but a clean word-range
            // diffOriginal. Using diffOriginal avoids the span-fragment trap.
            original: item.diffOriginal,
            onAddToDictionary:
                item.category === 'spelling' && item.diffOriginal.trim().length > 0
                    ? (word: string) => void addWordToDictionary(el, item, word)
                    : undefined,
            onApply: (replacementIndex: number) => {
                const live = getText(el)
                if (!isSpanStillValid(live, item)) {
                    closePopoverFor(el)
                    void rerunFor(el)(live)
                    return
                }
                const replacement =
                    item.replacements[replacementIndex] ?? item.replacements[0] ?? ''
                applyFix(el, { start: item.cuStart, end: item.cuEnd }, replacement)
                const st = fields.get(el)
                if (st) {
                    st.lastApplied = appendInverseEdit([], {
                        start: item.cuStart,
                        end: item.cuEnd,
                        replacement,
                        original: item.original,
                    })
                }
                signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'vencord',
                })
                closePopoverFor(el)
                void rerunFor(el)(getText(el))
            },
            onIgnore: () => {
                const st = fields.get(el)
                if (!st) return
                const idx = st.items.indexOf(item)
                if (idx >= 0) st.items.splice(idx, 1)
                renderField(el, st)
                signalQueue.enqueue({
                    id: item.id,
                    action: 'ignored',
                    category: item.category,
                    source: 'vencord',
                })
                closePopoverFor(el)
            },
        })
        openPopovers.set(el, handle)
    }

    // Resolve the composer's CURRENT non-empty selection into a code-unit
    // span + the slice text. Returns null when there is no usable selection
    // (collapsed, empty, or no tracked field). Discord composers are always
    // contenteditable (no textarea/input branch — the bridge always sees
    // Slate), so the contenteditable path is the only one.
    const resolveSelection = (): {
        el: HTMLElement
        text: string
        span: { start: number; end: number }
    } | null => {
        const el = focusedTrackedField()
        if (!el) return null
        const sel = el.ownerDocument.getSelection()
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
        const range = sel.getRangeAt(0)
        if (!el.contains(range.commonAncestorContainer)) return null
        const start = domPointToFlatOffset(el, range.startContainer, range.startOffset)
        const end = domPointToFlatOffset(el, range.endContainer, range.endOffset)
        const span = resolveSelectionSpan(start, end)
        // Slice the FLAT model (not range.toString(), which omits the virtual
        // newlines) so the rephrase stale-guard `live.slice(...) === text`
        // compares like with like on multi-line selections.
        const text = getText(el).slice(span.start, span.end)
        if (!text.trim()) return null
        return { el, text, span }
    }

    // Rephrase the focused composer's current selection (when usable), else
    // the WHOLE field. No selection → use whole text as the span.
    const rephraseFor = (el: HTMLElement): void => {
        const found = resolveSelection()
        if (found && found.el === el) {
            void openRephraseFor(el, found.text, found.span)
            return
        }
        const text = getText(el)
        if (!text.trim()) return
        void openRephraseFor(el, text, { start: 0, end: text.length })
    }

    // Rephrase the given selection: call the bridge (slow LLM path), show a
    // pending state, then a result card. Apply replaces the SELECTION span.
    const openRephraseFor = async (
        el: HTMLElement,
        text: string,
        span: { start: number; end: number },
    ): Promise<void> => {
        debugLog('rephrase start', { textLen: text.length, span })
        const pending = showRephrasePending(overlay.root, {
            anchorRect: el.getBoundingClientRect(),
            onClose: () => {},
        })
        try {
            const res = await refreshClient().rephrase({ text, source: 'vencord' })
            pending.hide()
            showRephraseCard(overlay.root, {
                anchorRect: el.getBoundingClientRect(),
                original: res.original,
                rephrased: res.rephrased,
                alternatives: res.alternatives,
                onApply: (chosen: string) => {
                    // Re-validate the span against live text: if the field
                    // changed since selection, the offsets may be stale.
                    // Only apply when the slice still equals the original
                    // selection.
                    const live = getText(el)
                    if (live.slice(span.start, span.end) !== text) {
                        debugLog('rephrase stale span; not applying')
                        return
                    }
                    applyFix(el, span, chosen)
                    void rerunFor(el)(getText(el))
                },
                onClose: () => {},
            })
            debugLog('rephrase done', { alternatives: res.alternatives.length })
        } catch (e) {
            debugLog('rephrase failed', e)
            pending.hide()
            showRephraseError(overlay.root, {
                anchorRect: el.getBoundingClientRect(),
                message: 'Rephrase failed',
                onRetry: () => void openRephraseFor(el, text, span),
                onClose: () => {},
            })
        }
    }

    const focusedTrackedField = (): HTMLElement | null => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return null
        if (fields.has(active)) return active
        for (const el of trackedFields) {
            if (el.contains(active)) return el
        }
        return null
    }

    // ---- Pill surface ----
    // Mount/update/teardown the status pill anchored to the active composer.
    // The pill tracks its field across scroll/resize (reposition). panelOpen
    // is the local book-keeping mirror of the pill's hover-panel state — the
    // pill's setVisible(false) is a no-op while its panel is open (so the
    // panel doesn't vanish mid-hover), and the pill's update() closes the
    // panel by design (we skip update while panelOpen so the next open
    // rebuilds with fresh data).
    const buildPillOptions = (el: HTMLElement, st: FieldState): StatusButtonOptions => {
        const corrections: PillCorrection[] = st.items.map((it) => ({
            category: it.category,
            diffOriginal: it.diffOriginal,
            diffCorrected: it.diffCorrected,
            diffIsDeletion: it.diffIsDeletion,
        }))
        return {
            count: st.items.length,
            byCategory: tallyByCategory(st.items),
            anchorRect: pillAnchor ?? el.getBoundingClientRect(),
            disabled: paused,
            corrections,
            onFocusField: () => el.focus(),
            onTogglePower: () => togglePause(),
            onRecheck: () => void rerunFor(el)(getText(el)),
            onApplyAll: () => void applyAllFor(el),
            onApplyOne: (i) => applyOneFor(el, i),
            onUndo: () => void undoFor(el),
            onRephrase: () => rephraseFor(el),
            undoAvailable: (st.lastApplied?.length ?? 0) > 0,
            initiallyVisible: true,
        }
    }

    // The pill positions itself INSIDE its anchor rect (clamped to the
    // bottom-right — browser semantics where the anchor is the whole text
    // field). Anchoring to the chat-bar BUTTON's own rect would therefore
    // place the pill ON the button, under the pointer: the wrapper's
    // mouseleave fires, the pill hides, the pointer re-enters — flicker —
    // and the pill covers the button. Hand the pill a synthetic anchor
    // ABOVE the button instead: right-aligned, with a gap, so button and
    // pointer stay clear (verified live 2026-06-10).
    const PILL_ANCHOR_WIDTH = 360
    const PILL_ANCHOR_HEIGHT = 64
    const PILL_ANCHOR_GAP = 8
    const pillAnchorAbove = (buttonRect: DOMRect): DOMRect =>
        new DOMRect(
            buttonRect.right - PILL_ANCHOR_WIDTH,
            buttonRect.top - PILL_ANCHOR_HEIGHT - PILL_ANCHOR_GAP,
            PILL_ANCHOR_WIDTH,
            PILL_ANCHOR_HEIGHT,
        )

    // Grace timer for hidePill so moving the pointer from the chat-bar
    // button ONTO the pill (to click its actions) doesn't hide it mid-way.
    // The pill node re-binds on every fresh mount (renderStatusButton
    // replaces the element).
    let pillHideTimer: ReturnType<typeof setTimeout> | null = null
    const cancelPillHide = (): void => {
        if (pillHideTimer != null) {
            clearTimeout(pillHideTimer)
            pillHideTimer = null
        }
    }
    const PILL_HIDE_GRACE_MS = 250

    // The browser pill idles at opacity 0.1 (styles.ts — it sits over the
    // user's text field and must not occlude). In the Vencord placement it
    // hovers over chrome, not text: force full opacity inline (inline style
    // beats the stylesheet rule; the hover transition still applies).
    const bindPillNode = (): void => {
        const node = overlay.root.querySelector<HTMLElement>('.gf-pill')
        if (!node || node.dataset.gfVencordBound === '1') return
        node.dataset.gfVencordBound = '1'
        node.style.opacity = '1'
        node.addEventListener('mouseenter', cancelPillHide)
        node.addEventListener('mouseleave', () => hidePill())
    }

    const showPill = (anchorRect: DOMRect): void => {
        const el = activeComposer()
        if (!el) return
        const st = fields.get(el)
        if (!st) return
        cancelPillHide()
        pillAnchor = pillAnchorAbove(anchorRect)
        // Update in place when the pill is already mounted (e.g. a resize
        // reposition); only build fresh on first mount.
        if (pillHandle && pillHandle.isMounted()) {
            pillHandle.update(buildPillOptions(el, st))
            pillHandle.setVisible(true)
            bindPillNode()
            return
        }
        pillHandle = renderStatusButton(overlay.root, buildPillOptions(el, st))
        panelOpen = false
        bindPillNode()
    }

    const hidePill = (): void => {
        if (panelOpen) return
        cancelPillHide()
        pillHideTimer = setTimeout(() => {
            pillHideTimer = null
            if (!panelOpen) pillHandle?.setVisible(false)
        }, PILL_HIDE_GRACE_MS)
    }

    const togglePanel = (anchorRect: DOMRect): void => {
        // Mount the pill first if it isn't already, then drive the panel.
        if (!pillHandle || !pillHandle.isMounted()) showPill(anchorRect)
        if (panelOpen) {
            pillHandle?.closePanel()
            panelOpen = false
        } else {
            pillHandle?.openPanel()
            panelOpen = true
        }
    }

    // togglePause: flip paused, clear every field's items + popovers, update
    // the pill (disabled: paused), notify subscribers. On resume, re-check
    // the focused composer so the user sees fresh state immediately.
    const togglePause = (): void => {
        paused = !paused
        debugLog('pause toggle', { paused })
        for (const [el, st] of fields) {
            closePopoverFor(el)
            st.items = []
            st.itemRects = []
            st.lastApplied = null
            renderField(el, st)
        }
        // Refresh the pill (disabled: paused) so the surface reflects the
        // new state. Skipped while a panel is open — the next open rebuilds.
        if (pillHandle && pillHandle.isMounted() && !panelOpen) {
            const el = activeComposer()
            const st = el ? fields.get(el) : null
            if (el && st) pillHandle.update(buildPillOptions(el, st))
        }
        notify()
        if (!paused) {
            // Re-check the focused composer so the user sees the resume take
            // effect. If no focused composer, fall through silently.
            const focused = focusedTrackedField()
            if (focused) void rerunFor(focused)(getText(focused))
        }
    }

    // Shared, rAF-coalesced scroll/resize loop. Re-measures every tracked
    // field's hit-test rects + reconciles its overlay highlights on scroll
    // or resize — without this, highlights and the click hit-test would
    // stay pinned at render-time viewport coords.
    let remeasureScheduled = false
    const scheduleRemeasureAll = (): void => {
        if (remeasureScheduled) return
        remeasureScheduled = true
        requestAnimationFrame(() => {
            remeasureScheduled = false
            for (const el of trackedFields) remeasureField(el)
        })
    }
    const remeasureField = (el: HTMLElement): void => {
        const st = fields.get(el)
        if (!st || st.items.length === 0) return
        const spans = st.items.map((it) => ({ start: it.hlStart, end: it.hlEnd }))
        let allRects: DOMRect[][]
        try {
            allRects = getSpanRectsBatch(el, spans)
        } catch {
            return
        }
        if (allRects.length === 0) return
        st.itemRects = st.items.map((it, i) => ({ item: it, rects: allRects[i] ?? [] }))
        if (!st.highlightLayer) st.highlightLayer = createHighlightLayer(overlay.root)
        const specs: HighlightSpec[] = []
        for (let i = 0; i < st.items.length; i++) {
            const item = st.items[i]!
            for (const rect of allRects[i] ?? []) {
                specs.push({ rect, category: item.category, itemIndex: i })
            }
        }
        st.highlightLayer.reconcile(specs)
        st.highlightLayer.setState({
            focused: document.activeElement === el,
            hoverItemIndex: null,
        })
    }
    document.addEventListener('scroll', scheduleRemeasureAll, { capture: true, passive: true })
    window.addEventListener('resize', scheduleRemeasureAll, { passive: true })
    cleanups.push(() => {
        document.removeEventListener('scroll', scheduleRemeasureAll, { capture: true })
        window.removeEventListener('resize', scheduleRemeasureAll)
    })

    const armPasteGrace = (el: HTMLElement, st: FieldState, attachment: FieldAttachment): void => {
        attachment.cancelPending()
        clearPasteGrace(st)
        st.pasteGraceTimer = setTimeout(() => {
            st.pasteGraceTimer = null
            void rerunFor(el)(getText(el))
        }, PASTE_GRACE_MS)
    }

    const attach = (el: HTMLElement): void => {
        if (fields.has(el)) return
        const rerun = rerunFor(el)
        // attachment is referenced inside onInputEvent (the cancelPending
        // call) and below (armPasteGrace). Declared as let so the closure
        // can read the final value after assignment; no input event can
        // fire synchronously during createFieldAttachment.
        let attachment: FieldAttachment
        const onInputEvent = (inputType: string): boolean => {
            if (paused) return false
            const decision = inputGate(inputType, {
                checkPastedText: getConfig().checkPastedText,
            })
            const st = fields.get(el)
            if (!st) return false
            if (decision === 'check') {
                clearPasteGrace(st)
                return true
            }
            if (decision === 'grace') armPasteGrace(el, st, attachment)
            else {
                attachment.cancelPending()
                clearPasteGrace(st)
            }
            return false
        }
        attachment = createFieldAttachment(
            el,
            {
                realtimeDelayMs: getConfig().realtimeDelayMs,
                onRunCheck: (_t, text) => void rerun(text),
                onBlur: () => void signalQueue.flush(),
                onInputEvent,
            },
            () => fields.size,
            () => {},
        )
        const st: FieldState = {
            attachment,
            items: [],
            itemRects: [],
            checkSeq: 0,
            pasteGraceTimer: null,
            highlightLayer: null,
            lastApplied: null,
        }
        fields.set(el, st)
        trackedFields.add(el)
        lastActiveField = el
        notify()

        // Discord's Slate editor intercepts `beforeinput` and applies the
        // edit through its own model — the browser never fires a native
        // `input` event on the composer (verified live 2026-06-10: typing
        // produced beforeinput only). The attachment's input listener is
        // therefore dead on Discord; drive the SAME gate + debouncer from a
        // capture-phase beforeinput listener. The text is read at debounce
        // FIRE time (500ms later), well after Slate has reconciled the DOM.
        // On editors that DO emit input events both paths coalesce in the
        // attachment's debouncer — no double-checking.
        const onFieldBeforeInput = (e: Event): void => {
            const inputType = (e as InputEvent).inputType ?? ''
            if (onInputEvent(inputType)) attachment.debouncedRun()
        }
        el.addEventListener('beforeinput', onFieldBeforeInput, { capture: true })
        cleanups.push(() =>
            el.removeEventListener('beforeinput', onFieldBeforeInput, { capture: true }),
        )
        // Release this field's paste-grace timer on global teardown. The
        // fields map is iterated separately in stop() (detaching each
        // field) — without this mirror, a pending grace could fire a
        // check after fields are gone.
        cleanups.push(() => {
            const s = fields.get(el)
            if (s) clearPasteGrace(s)
        })

        // Click → hit-test → popover. The highlight layer is
        // pointer-events:none, so clicks reach the field; the click
        // handler maps the pointer to an item via itemRects.
        const onFieldClick = (e: MouseEvent): void => {
            const s = fields.get(el)
            if (!s) return
            const hit = hitTest(s.itemRects, e.clientX, e.clientY)
            // Payload guarded explicitly: selectionDebugInfo walks the DOM,
            // and debugLog's internal gate would not stop the EAGER argument
            // evaluation. Zero work unless debug logging is enabled.
            if (getConfig().debugLogging) {
                debugLog('composer click', {
                    x: e.clientX,
                    y: e.clientY,
                    items: s.items.length,
                    hit: hit
                        ? { original: hit.item.diffOriginal, category: hit.item.category }
                        : null,
                    selection: selectionDebugInfo(el),
                })
            }
            if (!hit) return
            openPopoverFor(el, hit.item, hit.rect)
        }
        el.addEventListener('click', onFieldClick)
        cleanups.push(() => el.removeEventListener('click', onFieldClick))

        // Focus-flow tracing for the caret-jump investigation: log every
        // focus hand-off involving the composer, with where focus went/came
        // from and the live selection state (Slate restores a remembered
        // selection on refocus — the suspected jump mechanism).
        const describeNode = (n: EventTarget | null): string => {
            if (!(n instanceof HTMLElement)) return String(n)
            return `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 50)}`
        }
        const onFieldFocusIn = (e: FocusEvent): void => {
            if (!getConfig().debugLogging) return
            debugLog('composer focusin', {
                from: describeNode(e.relatedTarget),
                selection: selectionDebugInfo(el),
            })
        }
        const onFieldFocusOut = (e: FocusEvent): void => {
            if (!getConfig().debugLogging) return
            debugLog('composer focusout', {
                to: describeNode(e.relatedTarget),
                selection: selectionDebugInfo(el),
            })
        }
        el.addEventListener('focusin', onFieldFocusIn)
        el.addEventListener('focusout', onFieldFocusOut)
        cleanups.push(() => {
            el.removeEventListener('focusin', onFieldFocusIn)
            el.removeEventListener('focusout', onFieldFocusOut)
        })

        // Focus on the composer: this is the field the user is now
        // editing — update lastActiveField so the pill's active-composer
        // resolution (focused → last-active) picks the right one even
        // after a blur→re-focus cycle.
        const onFieldFocus = (): void => {
            lastActiveField = el
        }
        el.addEventListener('focus', onFieldFocus)
        cleanups.push(() => el.removeEventListener('focus', onFieldFocus))

        // Native `paste` fallback for rich editors (Discord/Lexical) that
        // apply the paste programmatically and fire NO input event with
        // inputType=insertFromPaste. Capture phase so we see it even if
        // the editor stops propagation; we never preventDefault. With
        // checkPastedText OFF the paste must still CANCEL any pending
        // debounced check — the editor's own post-paste input event may
        // carry a generic inputType that the gate reads as typing, and
        // without the cancel the pasted text would be checked (violating
        // the typed-input-only invariant).
        const onFieldPaste = (): void => {
            const s = fields.get(el)
            if (!s) return
            if (paused) return
            if (getConfig().checkPastedText) {
                armPasteGrace(el, s, attachment)
                return
            }
            attachment.cancelPending()
            clearPasteGrace(s)
        }
        el.addEventListener('paste', onFieldPaste, { capture: true })
        cleanups.push(() => el.removeEventListener('paste', onFieldPaste, { capture: true }))
    }

    const detach = (el: HTMLElement): void => {
        const st = fields.get(el)
        if (!st) return
        clearPasteGrace(st)
        st.highlightLayer?.destroy()
        st.highlightLayer = null
        openPopovers.get(el)?.hide()
        openPopovers.delete(el)
        st.attachment.detach()
        trackedFields.delete(el)
        fields.delete(el)
        if (lastActiveField === el) {
            lastActiveField = null
            // Refresh the pill if it was anchored to the detached field.
            // Use the new active composer (or null → no active pill).
            const next = activeComposer()
            if (pillHandle && pillHandle.isMounted() && !panelOpen) {
                if (next) {
                    const ns = fields.get(next)
                    if (ns) pillHandle.update(buildPillOptions(next, ns))
                } else {
                    pillHandle.setVisible(false)
                }
            }
        }
        notify()
    }

    const stopObserver = createFieldObserver({
        root: document.body,
        onFieldDiscovered: (el) => {
            if (isDiscordComposer(el)) {
                debugLog('composer attached', el.className)
                attach(el)
            }
        },
        onFieldDetached: (el) => detach(el),
    })
    cleanups.push(stopObserver)

    // Accept hotkey (capture phase on document). Applies the FIRST
    // suggestion of the focused composer; only acts when the chord
    // matches AND the field has suggestions — so Tab, normal typing, and
    // other key combos pass through.
    const onKeydown = (e: KeyboardEvent): void => {
        const field = focusedTrackedField()
        if (!field) return
        const st = fields.get(field)
        if (!st || st.items.length === 0) return
        // Only log chorded keys (a modifier held) so plain typing stays quiet.
        if (e.ctrlKey || e.altKey || e.metaKey) {
            debugLog('keydown', {
                key: e.key,
                code: e.code,
                ctrl: e.ctrlKey,
                alt: e.altKey,
                shift: e.shiftKey,
                meta: e.metaKey,
                configured: getConfig().acceptHotkey,
                items: st.items.length,
            })
        }
        let matched = false
        try {
            matched = shouldAcceptHotkey(e, {
                hotkey: getConfig().acceptHotkey,
                hasActiveSuggestion: true,
            })
        } catch (err) {
            // parseHotkey throws on a malformed configured string; a broken
            // setting must not turn every keystroke into an uncaught error.
            debugLog('hotkey parse failed', getConfig().acceptHotkey, err)
            return
        }
        if (!matched) return
        debugLog('hotkey matched — applying first suggestion')
        e.preventDefault()
        e.stopPropagation()
        const first = st.items[0]
        if (first) applyItem(field, first)
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    cleanups.push(() => document.removeEventListener('keydown', onKeydown, { capture: true }))

    // Track panel state transitions for the pill. The pill's hover panel
    // is one-per-root (showPanel / hidePanel inside status-button.ts);
    // the local `panelOpen` mirror lets hidePill / renderField skip the
    // pill update while the panel is open (update() closes the panel).
    // We hook the pill's own methods via a thin proxy: wrap openPanel /
    // closePanel to flip the flag, but leave the underlying behaviour
    // intact. The proxy is set after the first pill mount (in showPill)
    // — see below.

    return {
        stop: () => {
            const attachedFields = Array.from(fields.keys())
            for (const el of attachedFields) detach(el)
            for (const c of cleanups) {
                try {
                    c()
                } catch {
                    /* best-effort teardown */
                }
            }
            cleanups.length = 0
            // Tear down the pill BEFORE the overlay so its destroy runs in
            // a live root.
            cancelPillHide()
            pillHandle?.destroy()
            pillHandle = null
            pillAnchor = null
            panelOpen = false
            dismissPopoversIn(overlay.root)
            dismissRephraseCardsIn(overlay.root)
            overlay.destroy()
            subscribers.clear()
            void signalQueue.flush()
        },
        getSummary: () => {
            const el = activeComposer()
            const st = el ? fields.get(el) : null
            return {
                count: st?.items.length ?? 0,
                byCategory: st ? tallyByCategory(st.items) : {},
                paused,
            }
        },
        subscribe: (cb) => {
            subscribers.add(cb)
            return () => {
                subscribers.delete(cb)
            }
        },
        showPill,
        hidePill,
        togglePanel,
        togglePause,
    }
}
