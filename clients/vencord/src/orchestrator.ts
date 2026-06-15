// Vencord orchestrator: the SOLE wirer for the Discord composer, composing
// the browser client's battle-tested layers (attachment/debounce, pipeline,
// overlay, popover, signal queue, status pill, rephrase card, dictionary).
// Mirrors clients/browser entrypoints/content/index.ts, adapted to Discord's
// contenteditable composer (no textarea/input branch, beforeinput-driven
// check, capture-phase paste fallback). All teardown handles are collected so
// stop() restores Discord to its unmonitored state.
import { showTooltip, dismissTooltipsIn, type TooltipHandle } from '@/overlay/tooltip'
import { createFieldObserver } from '@/input/observer'
import { createFieldAttachment, type FieldAttachment } from '@/input/attachment'
import { isPasteInput, shouldCheckInput } from '@/input/paste-guard'
import { domPointToFlatOffset, getText } from '@/input/text'
import { getCaretOffset, keepHighlightsBeforeEdit } from '@/input/caret-offset'
import { nextCheckSeq } from '@/lib/check-seq'
import { applySlateFix, type ApplyTraceLogger } from '@/input/rich-editor-apply'
import {
    buildRenderableItems,
    isSpanStillValid,
    tallyByCategory,
    type RenderableItem,
} from '@/lib/pipeline'
import { appendInverseEdit, planUndo, type InverseEdit } from '@/lib/undo'
import { applyScopedOverlayClear } from '@/lib/scoped-clear'
import { BridgeClient } from '@/api/client'
import { createSignalQueue } from '@/signal/queue'
import { addWordToDictionary, type DictionaryDeps } from './dictionary'
import { openRephraseFor, resolveRephraseScope, type RephraseDeps } from './rephrase'
import { configureVencordDebug, debugLog } from './debug-log'
import { createOverlayHost, isWithinOverlay } from '@/overlay/shadow-host'
import { mountScanline, removeScanline, type ScanlineHandle } from '@/overlay/scanline'
import { getSpanRectsBatch } from '@/overlay/rect'
import { createHighlightLayer, type HighlightLayer, type HighlightSpec } from '@/overlay/highlight'
import { showPopover, dismissPopoversIn, type PopoverHandle } from '@/overlay/popover'
import {
    renderStatusButton,
    type PillCorrection,
    type StatusButtonHandle,
    type StatusButtonOptions,
} from '@/overlay/status-button'
import { showPanel, type PanelHandle, type PanelOptions } from '@/overlay/panel'
import { showGoals, type GoalsHandle } from '@/overlay/goals'
import { mountStatsView, type StatsViewHandle, type StatsViewDeps } from '@/overlay/stats-view'
import { resolveWordFromDblClick, showSynonyms, type SynonymsHandle } from '@/overlay/synonyms'
import { showToast } from '@/overlay/toast'
import {
    computeScore,
    scoreBand,
    visibleItems,
    highConfidenceItems,
    defaultToneFromGoals,
} from '@/lib/view-model'
import type { Phase, Category } from '@/api/types'
import { dismissRephraseCardsIn } from '@/overlay/rephrase-card'
import { shouldAcceptHotkey } from '@/hotkeys/accept'
import { shouldRephraseHotkey } from '@/hotkeys/rephrase-target'
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
function selectionDebugInfo(el: HTMLElement): string {
    const sel = el.ownerDocument.getSelection()
    if (!sel || sel.rangeCount === 0) return 'no-selection'
    const range = sel.getRangeAt(0)
    if (!el.contains(range.startContainer)) return 'outside-composer'
    const start = domPointToFlatOffset(el, range.startContainer, range.startOffset)
    const end = domPointToFlatOffset(el, range.endContainer, range.endOffset)
    // Stringified so the console prints it INLINE — collapsed `{…}` objects
    // in pasted logs hid exactly the offsets this exists to capture.
    return `[${String(start)},${String(end)})${range.collapsed ? ' collapsed' : ''}`
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

/** Pure: given cursor (x,y) + itemRects + the previous hoverItemIndex, return
 *  the new index (or null) and whether it changed. Extracted so the hover
 *  decision is unit-testable without a DOM listener harness. */
export function hoverDecision(
    itemRects: ReadonlyArray<{ item: RenderableItem; rects: DOMRect[] }>,
    x: number,
    y: number,
    prevIndex: number | null,
): { index: number | null; changed: boolean } {
    let index: number | null = null
    for (let i = 0; i < itemRects.length; i++) {
        const entry = itemRects[i]!
        for (const r of entry.rects) {
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                index = i
                break
            }
        }
        if (index !== null) break
    }
    return { index, changed: index !== prevIndex }
}

/** Pure: build the glanceable preview text for a hover tooltip chip.
 *  Mirrors the browser client's tooltip content: "original → corrected"
 *  or "original → (deleted)" for deletions. */
export function buildHoverPreviewText(item: RenderableItem): string {
    if (item.diffIsDeletion) return `${item.diffOriginal} → (deleted)`
    return `${item.diffOriginal} → ${item.diffCorrected}`
}

interface FieldState {
    attachment: FieldAttachment
    items: RenderableItem[]
    itemRects: Array<{ item: RenderableItem; rects: DOMRect[] }>
    checkSeq: number
    pasteGraceTimer: ReturnType<typeof setTimeout> | null
    highlightLayer: HighlightLayer | null
    /** Index of the item the pointer is currently hovering (parallel to
     *  items), or null when nothing is hovered. Drives the per-word
     *  highlight intensity via highlightLayer.setState({hoverItemIndex}).
     *  Mirrors the browser client's FieldState.hoverItemIndex. */
    hoverItemIndex: number | null
    /** Last apply action's inverse edits (single undo slot; a new apply
     *  overwrites it, undo consumes it). null = nothing to undo. Per-field
     *  so a settings-driven teardown doesn't lose it and different fields
     *  don't share an undo queue. */
    lastApplied: InverseEdit[] | null
    /** Streaming phase of the latest check for THIS field. `'fast'` is the
     *  local-rules preview (Harper + GECToR + cached LLM); `'done'` includes
     *  the LLM escalation. LLM items are suppressed from visibleItems()
     *  while in 'fast'. Per-field so a re-check on one composer doesn't
     *  leak phase into another. */
    phase: Phase
    /** W3-3 follow-up: per-field scan-line handle. Mounted when this field
     *  enters `phase === 'fast'` (the streaming fast→slow window, which
     *  the orb pip + panel banner already key on) and removed on
     *  `phase === 'done'` / teardown. Per-field so two composers with
     *  overlapping phase windows don't share a sweep. */
    scanlineHandle: ScanlineHandle | null
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
    // Millisecond timestamps (relative to orchestrator start) make event
    // ORDER and latency visible — essential for the async-apply traces.
    // The actual write is delegated to ./debug-log.ts which wraps the
    // shared Console backend with the per-call +Xms prefix.
    configureVencordDebug({
        startMs: performance.now(),
        isEnabled: () => getConfig().debugLogging,
    })
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
    // W3-4: Vencord is always dark (Discord is always dark). Set the
    // data-gf-theme attribute on the host so the design tokens resolve
    // against the dark palette regardless of the user's OS preference.
    // The shared createOverlayHost() does not set this — it is a
    // per-client choice (the browser also handles light + OS-watcher
    // there; Vencord skips the light path entirely).
    ;(overlay.host as HTMLElement).dataset.gfTheme = 'dark'
    // Deps bundle for the extracted addWordToDictionary (./dictionary.ts).
    // Built here so the deps reference the live closures (refreshClient,
    // rerunFor, signalQueue, overlay.root) instead of being passed in.
    const dictionaryDeps: DictionaryDeps = {
        client: () => refreshClient(),
        signalQueue,
        rerun: (el) => (text) => rerunFor(el)(text),
        overlayRoot: overlay.root,
    }
    // Deps bundle for the extracted openRephraseFor (./rephrase.ts).
    // W3-3: pass a `defaultTone` getter so the rephrase card's
    // initial tone is seeded from the user's goals (formal→Formal,
    // informal→Casual, neutral→Neutral). The card still lets the user
    // override per-request — this is the seed only.
    const rephraseDeps: RephraseDeps = {
        client: () => refreshClient(),
        overlayRoot: overlay.root,
        debugLog,
        defaultTone: () => defaultToneFromGoals(getConfig().goals),
    }
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
    let reviewPanel: PanelHandle | null = null
    /** The field the review panel is currently open for. Used by renderField
     *  to refresh the panel body in-place when a check resolves with new items
     *  (mirrors browser orchestrator's runtime.panelFor). */
    let panelFor: HTMLElement | null = null
    // W3-3: completion of the W2b panel callback wiring. The W2b NIT2
    // (panel.ts exported onOpenGoals/onOpenStats but the orchestrator
    // stubbed them) gets these real surfaces here. One handle per overlay
    // (showGoals + showSynonyms + mountStatsView each dismiss the prior
    // on a new mount — the orchestrator's track-and-destroy is defensive).
    let goalsHandle: GoalsHandle | null = null
    let statsHandle: StatsViewHandle | null = null
    let synonymsHandle: SynonymsHandle | null = null
    let lastActiveField: HTMLElement | null = null
    // Single hover tooltip (one per overlay, mirrors browser client).
    // Shared across all fields; a new showTooltip call dismisses the prior.
    let activeTooltip: TooltipHandle | null = null
    let activeTooltipItem: RenderableItem | null = null

    const clearPasteGrace = (st: FieldState): void => {
        if (st.pasteGraceTimer != null) {
            clearTimeout(st.pasteGraceTimer)
            st.pasteGraceTimer = null
        }
    }

    /** Hide the hover tooltip immediately and reset tracking state.
     *  Called on blur, detach, click (before opening the popover), and
     *  teardown — mirrors the browser client's hideTooltipNow. */
    const hideTooltipNow = (): void => {
        activeTooltip?.hide()
        activeTooltip = null
        activeTooltipItem = null
        dismissTooltipsIn(overlay.root)
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
        // W3-3 follow-up: measure the composer rect BEFORE any rerender of
        // the underlay (flows.md §3 gotcha — a post-mutation rect is all
        // zeros and the scan-line would anchor to 0,0). The pill's anchor
        // reads from the same value when no pill is mounted yet, so the
        // two surfaces always agree on the field's box.
        const anchor = el.getBoundingClientRect()
        // W3-3 follow-up: scan-line mount/remove keyed on the SAME phase
        // signal as the orb pip + panel banner. `phase === 'fast'` →
        // mount (or re-anchor the live handle if the composer grew during
        // typing); `phase === 'done'` → detach. Runs BEFORE the
        // items===0 early return so a phase-flipped catch path
        // (items cleared, phase='done' — see rerunFor's catch arm) still
        // tears down a stale scan-line. Per-field via st.scanlineHandle —
        // a second composer's mount doesn't share a sweep with this one.
        if (st.phase === 'fast') {
            if (st.scanlineHandle && st.scanlineHandle.isMounted()) {
                st.scanlineHandle.update(anchor)
            } else {
                st.scanlineHandle = mountScanline(overlay, anchor)
            }
        } else if (st.scanlineHandle) {
            removeScanline(st.scanlineHandle)
            st.scanlineHandle = null
        }
        if (st.items.length === 0) {
            st.highlightLayer?.reconcile([])
            // A cleared field is no longer "last-active" unless the user is
            // still on it (zero items just means no suggestions).
            if (lastActiveField === el && document.activeElement !== el) {
                lastActiveField = null
            }
            // Refresh the pill (count → 0) if mounted. The W2b review
            // panel owns its own data snapshot — pill.update() no longer
            // closes the panel (the W1 hover-panel behaviour is gone),
            // so the prior `!panelOpen` skip is stale and the update
            // can run unconditionally.
            const zeroPillUpdated = !!(pillHandle && pillHandle.isMounted())
            if (pillHandle && pillHandle.isMounted()) {
                pillHandle.update(buildPillOptions(el, st))
            }
            debugLog('render', { items: 0, pillUpdated: zeroPillUpdated, panelOpen })
            notify()
            // Panel refresh (zero items → empty state): if the review panel
            // is open for this field, rebuild the body in-place so the
            // "No issues remaining" empty state appears immediately.
            if (panelFor === el && reviewPanel?.isOpen()) {
                reviewPanel.restoreReviewBody(
                    st.items,
                    getText(el),
                    getConfig().goals,
                    st.phase ?? 'done',
                    false, // Vencord has no rephrase button in the panel
                )
            }
            return
        }
        // Highlight/hit-test the WORD range (hlStart/hlEnd), not the raw edit
        // span — a zero-width insertion (e.g. "sw"->"saw") has no rect.
        const spans = st.items.map((it) => ({ start: it.hlStart, end: it.hlEnd }))
        let allRects: DOMRect[][] | null = null
        try {
            const measured = getSpanRectsBatch(el, spans)
            if (measured.length > 0) allRects = measured
        } catch {
            // Spec §4 sibling: measurement-throw → clear itemRects + the
            // highlight layer. Better no highlight than a stale one — the
            // next remeasure (scroll/resize, or the next edit) re-populates
            // from a clean slate. Pill update below still runs (count data
            // must never depend on rect measurability).
            st.itemRects = []
            st.highlightLayer?.reconcile([])
        }
        if (allRects) {
            st.itemRects = st.items.map((it, i) => ({ item: it, rects: allRects![i] ?? [] }))
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
        // Refresh the pill if mounted. The W2b review panel keeps its
        // OWN snapshot of items/goals/phase at open time (panel.ts uses
        // buildPanelModel once and never re-reads live state), so a
        // pill.update() while the panel is open is safe — the panel
        // stays mounted + readable while the orb's count/band/ring stay
        // live. The W1 `!panelOpen` skip is stale; remove it.
        const pillUpdated = !!(pillHandle && pillHandle.isMounted())
        if (pillHandle && pillHandle.isMounted()) {
            pillHandle.update(buildPillOptions(el, st))
        }
        debugLog('render', {
            items: st.items.length,
            rectsMeasured: allRects != null,
            pillUpdated,
            panelOpen,
        })
        notify()
        // Panel refresh: if the review panel is open for this field, rebuild
        // its body in-place with the fresh items/score so applied suggestions
        // disappear and the score ring + insights update.
        // Stale-guard: only refresh when panelFor === el AND the panel is
        // still mounted (mirrors browser orchestrator's renderField hook).
        if (panelFor === el && reviewPanel?.isOpen()) {
            reviewPanel.restoreReviewBody(
                st.items,
                getText(el),
                getConfig().goals,
                st.phase ?? 'done',
                false, // Vencord has no rephrase button in the panel
            )
        }
    }

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const st = fields.get(el)
            if (!st) return
            if (paused) return
            if (!el.isConnected) {
                st.items = []
                // W3-3 follow-up: a detached field can't host a scan-line.
                // Reset phase so the gate tears it down (a stale 'fast'
                // from a mid-check fast frame would otherwise leave a
                // sweep pinned to 0,0 in the overlay host).
                st.phase = 'done'
                renderField(el, st)
                return
            }
            const seq = ++st.checkSeq
            debugLog('check start', { seq, textLen: text.length })
            // W3-3: streaming fast→slow. The bridge's /correct/stream returns
            // a `fast` frame (Harper + GECToR + cached LLM) then a `final`
            // frame (LLM escalation). We render `fast` immediately so the
            // user sees motion; `final` supersedes with the complete set.
            // The bridge client falls back to plain /correct when streaming
            // is unsupported (older bridge versions), in which case onFast
            // is never called and we land directly on `done`.
            try {
                const res = await refreshClient().correctStream(
                    { text, source: 'vencord' },
                    (fastRes) => {
                        if (seq !== st.checkSeq) return
                        st.items = buildRenderableItems(text, fastRes).items
                        st.phase = 'fast'
                        debugLog('check fast', { seq, items: st.items.length })
                        renderField(el, st)
                    },
                )
                if (seq !== st.checkSeq) return
                st.items = buildRenderableItems(text, res).items
                st.phase = 'done'
                debugLog('check done', { seq, items: st.items.length })
                renderField(el, st)
            } catch (e) {
                // Bridge unreachable / stream errored — possibly AFTER the
                // fast callback fired (correctStream delivered the fast
                // frame, then the LLM leg rejected). The previous behaviour
                // left `st.phase === 'fast'` and the review panel's
                // streaming banner stuck on the next open. Mirror the
                // browser's catch path (state.phase = 'done' + clear items
                // + re-render) so the field is consistent AND the next
                // panel open reads phase='done' and skips the banner.
                if (seq === st.checkSeq) {
                    st.items = []
                    st.phase = 'done'
                    renderField(el, st)
                }
                debugLog('check failed', e)
            }
        }

    // Apply an item's PRIMARY replacement, stale-guarded. Records the
    // inverse edit on the field's undo slot and emits the accepted signal.
    // Returns false (no-op) when the span has gone stale. Async: the Slate-
    // aware apply yields a tick between selection and insert (see
    // slate-apply.ts — the sync applyFix corrupted Slate's selection state).
    // W3-3: every mutation surfaces an Undo toast. The single-item path
    // shows "Fixed {original} → {replacement}" + Undo; the batch path
    // shows "Fixed N suggestions" + Undo (one click restores them all).
    const applyItem = async (el: HTMLElement, item: RenderableItem): Promise<boolean> => {
        const st = fields.get(el)
        if (!st) return false
        if (!isSpanStillValid(getText(el), item)) {
            void rerunFor(el)(getText(el))
            return false
        }
        const replacement = item.replacements[0] ?? ''
        const applied = await applySlateFix(
            el,
            { start: item.cuStart, end: item.cuEnd },
            replacement,
            debugLog as unknown as ApplyTraceLogger,
        )
        if (!applied) {
            void rerunFor(el)(getText(el))
            return false
        }
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
        showToast(overlay.root, {
            message: `Fixed \u201C${item.diffOriginal}\u201D \u2192 \u201C${replacement}\u201D`,
            actionLabel: 'Undo',
            onAction: () => void undoFor(el),
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
        void applyItem(el, item)
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
            const applied = await applySlateFix(
                el,
                { start: item.cuStart, end: item.cuEnd },
                replacement,
                debugLog as unknown as ApplyTraceLogger,
            )
            if (!applied) continue
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
        if (batch.length > 0) {
            st.lastApplied = batch
            // W3-3: surface a single batch-Undo toast (the toast's Undo
            // action reverts the whole batch via `undoFor`).
            showToast(overlay.root, {
                message: `Fixed ${String(batch.length)} suggestion${batch.length === 1 ? '' : 's'}`,
                actionLabel: 'Undo',
                onAction: () => void undoFor(el),
            })
        }
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
            await applySlateFix(
                el,
                op.span,
                op.replacement,
                debugLog as unknown as ApplyTraceLogger,
            )
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

    /** Measure the on-screen rect of a word range. The shared
     *  `getSpanRectsBatch` returns a DOMRect[] per range — we use the
     *  first rect (the dominant baseline rect) for anchor positioning.
     *  Returns null when measurement throws or returns empty (the word
     *  is in a detached subtree, or a zero-width surrogate pair). */
    const measureWordRect = (fieldEl: HTMLElement, text: string, start: number, end: number): DOMRect | null => {
        try {
            const rects = getSpanRectsBatch(fieldEl, [{ start, end }])
            const first = rects[0]?.[0]
            return first ?? null
        } catch {
            return null
        }
    }

    /** Close the active synonyms popover, if any. Idempotent. */
    const closeSynonyms = (): void => {
        synonymsHandle?.destroy()
        synonymsHandle = null
    }

    /** Apply a synonym swap: stale-guard → applySlateFix → signal →
     *  Undo toast → re-check. Mirror of `applyItem` but the toast reads
     *  as "Synonym applied" with the new word and the Undo re-runs the
     *  inverse (the previous word). */
    const applySynonym = async (
        el: HTMLElement,
        resolved: { word: string; start: number; end: number },
        synonym: string,
    ): Promise<void> => {
        const st = fields.get(el)
        if (!st) return
        const live = getText(el)
        const slice = live.slice(resolved.start, resolved.end)
        if (slice !== resolved.word) {
            debugLog('synonym stale slice; not applying', { slice, expected: resolved.word })
            void rerunFor(el)(live)
            return
        }
        const applied = await applySlateFix(
            el,
            { start: resolved.start, end: resolved.end },
            synonym,
            debugLog as unknown as ApplyTraceLogger,
        )
        if (!applied) {
            void rerunFor(el)(live)
            return
        }
        st.lastApplied = appendInverseEdit(st.lastApplied ?? [], {
            start: resolved.start,
            end: resolved.end,
            replacement: synonym,
            original: resolved.word,
        })
        showToast(overlay.root, {
            message: `Synonym: ${resolved.word} \u2192 ${synonym}`,
            actionLabel: 'Undo',
            onAction: () => void undoFor(el),
        })
        closeSynonyms()
        void rerunFor(el)(getText(el))
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
                    ? (word: string) => void addWordToDictionary(el, item, word, dictionaryDeps)
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
                // Close the popover BEFORE the async apply: applySlateFix
                // re-focuses the composer, and a still-open popover's
                // outside-click/teardown must not fight that focus move.
                closePopoverFor(el)
                void applySlateFix(
                    el,
                    { start: item.cuStart, end: item.cuEnd },
                    replacement,
                    debugLog as unknown as ApplyTraceLogger,
                ).then((applied) => {
                    if (!applied) {
                        void rerunFor(el)(getText(el))
                        return
                    }
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
                    void rerunFor(el)(getText(el))
                })
            },
            onIgnore: () => {
                // W3-3: dismiss → 'rejected' signal (the W1 'ignored' is
                // superseded; the spec now uses 'rejected' for the user-
                // dismissed path so the learning loop has a clean
                // accept/reject signal pair). Also: an Undo toast so the
                // dismiss is reversible (re-shows the item in place).
                const st = fields.get(el)
                if (!st) return
                const idx = st.items.indexOf(item)
                if (idx >= 0) st.items.splice(idx, 1)
                renderField(el, st)
                signalQueue.enqueue({
                    id: item.id,
                    action: 'rejected',
                    category: item.category,
                    source: 'vencord',
                })
                showToast(overlay.root, {
                    message: `Won\u2019t flag \u201C${item.diffOriginal}\u201D again`,
                    actionLabel: 'Undo',
                    onAction: () => {
                        // Restore the item in place at its original index.
                        if (idx >= 0 && !st.items.includes(item)) {
                            st.items.splice(idx, 0, item)
                            renderField(el, st)
                        }
                    },
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

    const focusedTrackedField = (): HTMLElement | null => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return null
        if (fields.has(active)) return active
        for (const el of trackedFields) {
            if (el.contains(active)) return el
        }
        return null
    }

    // Rephrase the focused field. Shared by the pill's onRephrase button
    // and the capture-phase rephrase hotkey. Selection-in-el → use it;
    // otherwise → whole field (whitespace-only fields short-circuit to
    // a no-op). Mirrors the browser's `rephraseFor` in
    // clients/browser/src/entrypoints/content/rephrase.ts.
    const rephraseFor = (el: HTMLElement): void => {
        const found = resolveSelection()
        const scope = resolveRephraseScope(
            el,
            found ? { el: found.el, text: found.text, span: found.span } : null,
        )
        if (!scope) return
        void openRephraseFor(scope.el, scope.text, scope.span, rephraseDeps, () => {
            void rerunFor(el)(getText(el))
        })
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
        // W3-3: drive the score ring + center glyph through the view-model
        // so the orb reflects the SAME math the review panel does. We
        // derive `visible` (informal mutes style) here, compute the score
        // + band once, and hand the orb the trio — `orbState` inside the
        // shared status-button turns the trio into ringColor / ringOffset
        // / center-glyph, so no scoring math lives in this file.
        const goals = getConfig().goals
        const visible = visibleItems(st.items, st.phase, goals)
        const score = computeScore(visible)
        const band = scoreBand(score)
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
            score,
            band,
            phase: st.phase,
            // W2-1: orb body click → show the review panel anchored to
            // the pill (the synthetic anchor above the chatbar button).
            // Fall back to the field's rect when the pill hasn't been
            // positioned yet (defensive — `pillAnchor` is set on the
            // first showPill, before onOpen can fire in practice).
            onOpen: () => {
                const anchor = pillAnchor ?? el.getBoundingClientRect()
                openReviewPanel(el, st, anchor)
            },
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

    // The browser orb idles at opacity 0.1 (styles.ts — it sits over the
    // user's text field and must not occlude). In the Vencord placement it
    // hovers over chrome, not text: force full opacity inline (inline style
    // beats the stylesheet rule; the hover transition still applies).
    // (Renamed .gf-pill → .gf-orb in the W2 redesign; selector + dataset
    // key kept distinct so a stale DOM cache doesn't double-bind.)
    const bindPillNode = (): void => {
        const node = overlay.root.querySelector<HTMLElement>('.gf-orb')
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
        // W2b: the chatbar button toggles the W2b review panel (the W1
        // hover panel is retired). The pill's body click (when present)
        // ALSO fires `onOpen` which lands in `openReviewPanel`, so the
        // entry point is uniform. The pill is mounted only as a position
        // source — the W2b review panel reads its own anchor from
        // `anchorRect`.
        if (!pillHandle || !pillHandle.isMounted()) showPill(anchorRect)
        if (panelOpen) {
            closeReviewPanel()
        } else {
            const el = activeComposer()
            const st = el ? fields.get(el) : null
            if (el && st) openReviewPanel(el, st, anchorRect)
        }
    }

    /** Open (or re-open) the W2b review panel for the given field. The
     *  panel renders its own goals/phase-aware content; the orchestrator
     *  owns the showGoals / mountStatsView / applyShowSwap lifecycles
     *  (the panel surface is callback-only — it does not know about
     *  the bridge or the orchestrator's deps). */
    const openReviewPanel = (el: HTMLElement, st: FieldState, anchor: DOMRect): void => {
        // One panel at a time: destroy any prior review panel BEFORE
        // building the new one (the W2b showPanel does this itself for
        // .gf-panel-aside siblings, but a teardown-then-mount is the
        // safer order for a re-open with new data).
        reviewPanel?.destroy()
        reviewPanel = null
        const opts = buildReviewPanelOptions(el, st, anchor)
        reviewPanel = showPanel(overlay.root, opts)
        panelOpen = true
        panelFor = el
    }

    const closeReviewPanel = (): void => {
        reviewPanel?.destroy()
        reviewPanel = null
        // Dismiss any child surfaces the panel opened (Goals popover,
        // Stats view, Synonyms popover). They each have their own
        // destroy() — calling them is idempotent.
        goalsHandle?.destroy()
        goalsHandle = null
        statsHandle?.destroy()
        statsHandle = null
        synonymsHandle?.destroy()
        synonymsHandle = null
        panelOpen = false
        panelFor = null
    }

    /** Build the W2b review panel options for the given field state. The
     *  W3 wiring finishes the surface's callback contract: the apply
     *  calls flow into the orchestrator's applyItem / applyAllFor /
     *  applyAllForCategory / applyAllForHighConf (toast + signal +
     *  inverse-edit bookkeeping is uniform), and the Goals + Stats
     *  entries open their child surfaces in the same overlay. */
    const buildReviewPanelOptions = (
        el: HTMLElement,
        st: FieldState,
        anchor: DOMRect,
    ): PanelOptions => {
        const goals = getConfig().goals
        return {
            anchorRect: anchor,
            items: st.items,
            text: getText(el),
            goals,
            // W3-3: per-field phase, not a hardcoded 'done'. While the
            // streaming LLM frame is still in flight, the panel shows
            // the streaming banner; once it lands, the LLM items appear.
            phase: st.phase,
            // W3-3b follow-up: when the site is paused (togglePause flipped
            // `paused` to true), the panel renders the paused empty-state
            // — "GrammarForge is paused" + "Turn on for this site". The
            // toggle button routes through onDisableSite → togglePause,
            // same as the active-mode footer. Same `paused` source the
            // pill reads for its `disabled: paused` flag, so orb-power
            // state and panel-disabled state agree.
            disabled: paused,
            // Panel clicks do not auto-close the panel (the user may
            // accept several suggestions before dismissing); the panel
            // stays open until × / Esc / onDisableSite. The apply
            // handlers do close the popover for the specific item.
            onAcceptAll: () => {
                void applyAllFor(el)
            },
            onAcceptHighConf: () => {
                void applyAllForHighConf(el)
            },
            onAcceptCategory: (cat: Category) => {
                void applyAllForCategory(el, cat)
            },
            onAcceptItem: (item: RenderableItem) => {
                closePopoverFor(el)
                void applyItem(el, item)
            },
            onOpenGoals: () => {
                // W3-3: Goals popover entry. The panel head has a
                // dedicated Goals pill; clicking it positions a Goals
                // popover above the pill, anchored to the panel head
                // (so the popover sits inside the panel's chrome
                // visually). The shared showGoals handles the outside-
                // click + Esc dismiss; onChange persists the goals to
                // settings + re-renders the panel with the new visible
                // filter + rephrase tone.
                const goalsRect = measureGoalsPillRect()
                if (!goalsRect) return
                const current = getConfig().goals
                goalsHandle?.destroy()
                goalsHandle = showGoals(overlay.root, {
                    anchorRect: goalsRect,
                    goals: current,
                    onChange: (next) => {
                        // Persist + re-render. The panel re-renders from
                        // a fresh model on next open; the in-flight panel
                        // keeps its old model until the user re-opens.
                        // A live update would require an update() on
                        // panel.ts — not in the W2b scope.
                        getConfig().goals = next
                        debugLog('goals change', next)
                    },
                    onClose: () => {
                        goalsHandle?.destroy()
                        goalsHandle = null
                    },
                })
            },
            onOpenStats: () => {
                // W3-3: Stats tab mounts the W2-4 view into the panel's
                // body slot (panel.getBodyContainer() returns the live
                // .gf-panel__body element; mountStatsView clears it and
                // renders its own tree). When the user switches back to
                // Review the next showPanel call rebuilds fresh.
                const body = reviewPanel?.getBodyContainer()
                if (!body) return
                statsHandle?.destroy()
                statsHandle = mountStatsView(body, buildStatsViewDeps())
            },
            onOpenReview: () => {
                // Review tab clicked — destroy the Stats view and re-open
                // the panel with fresh review content (same pattern as the
                // browser orchestrator). Re-read st + anchor live so the
                // panel gets fresh items/phase and the correct field rect.
                statsHandle?.destroy()
                statsHandle = null
                const stNow = fields.get(el)
                if (!stNow) return
                const anchorNow = el.getBoundingClientRect()
                openReviewPanel(el, stNow, anchorNow)
            },
            onRecheck: () => void rerunFor(el)(getText(el)),
            onDisableSite: () => {
                // W3-3b: per-site disable. The panel footer button
                // toggles the runtime-wide pause; the disabled empty-
                // state needs a `disabled` prop on PanelOptions that's
                // not in the W2b shared surface — see W3-3b report.
                togglePause()
                closeReviewPanel()
            },
            onClose: () => {
                closeReviewPanel()
            },
        }
    }

    /** The deps bundle for `mountStatsView`. Wires the bridge client's
     *  stats / dictionary endpoints and the orchestrator's rerun closure
     *  so dictionary-add / remove paths stay in lockstep with the
     *  the live re-check loop. */
    const buildStatsViewDeps = (): StatsViewDeps => ({
        loadStats: () => refreshClient().stats(),
        loadDict: () =>
            refreshClient().dictionaryList().then((r) => r.words).catch(() => []),
        removeDictWord: (word: string) => refreshClient().dictionaryRemove(word),
    })

    /** Locate the panel's Goals pill rect (caller-measured — the surface
     *  contract: never self-measure). Walks the live review panel DOM
     *  for `[data-action="open-goals"]`; returns null if the panel
     *  has been torn down or the pill is offscreen. */
    const measureGoalsPillRect = (): DOMRect | null => {
        if (!reviewPanel) return null
        // The panel's body is in overlay.root; the head (with the pill)
        // is a sibling. Walk all .gf-panel-aside nodes; pick the live
        // one (only one should ever be mounted — showPanel replaces).
        const panels = overlay.root.querySelectorAll('.gf-panel-aside')
        for (const p of Array.from(panels)) {
            if (!p.isConnected) continue
            const pill = p.querySelector<HTMLElement>('[data-action="open-goals"]')
            if (pill) return pill.getBoundingClientRect()
        }
        return null
    }

    // ---- Apply chains: category / high-confidence / single ----
    // The review panel exposes three bulk-accept entry points beyond
    // the chatbar's applyAllFor: per-category and high-confidence only.
    // Both reuse the per-item apply machinery (applySlateFix + signal +
    // inverse-edit bookkeeping) with the same frame-yield as applyAllFor
    // so Slate reconciles between edits. The unified entry-point
    // `applyBatchFor` keeps the batch ordering + inverse-edit assembly in
    // one place; the three variants just choose which items to feed it.

    /** Apply the given items, last-to-first, with frame yields. Records
     *  the combined inverse-edit batch on the field's undo slot. Mirrors
     *  `applyAllFor` but accepts a pre-filtered set (e.g. high-confidence
     *  only, or one category). */
    const applyBatchFor = async (el: HTMLElement, items: readonly RenderableItem[]): Promise<void> => {
        const st = fields.get(el)
        if (!st) return
        if (items.length === 0) return
        closePopoverFor(el)
        const ordered = [...items].sort((a, b) => b.cuStart - a.cuStart)
        const signaled = new Set<number>()
        let batch: InverseEdit[] = []
        for (const item of ordered) {
            if (!el.isConnected) return
            if (!isSpanStillValid(getText(el), item)) continue
            const replacement = item.replacements[0] ?? ''
            const applied = await applySlateFix(
                el,
                { start: item.cuStart, end: item.cuEnd },
                replacement,
                debugLog as unknown as ApplyTraceLogger,
            )
            if (!applied) continue
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
        debugLog('apply batch', { count: batch.length })
        void rerunFor(el)(getText(el))
    }

    /** Apply only the visible, high-confidence (>= 0.90) suggestions. */
    const applyAllForHighConf = async (el: HTMLElement): Promise<void> => {
        const st = fields.get(el)
        if (!st) return
        const goals = getConfig().goals
        const visible = visibleItems(st.items, st.phase, goals)
        await applyBatchFor(el, highConfidenceItems(visible))
    }

    /** Apply every visible suggestion in a single category. */
    const applyAllForCategory = async (el: HTMLElement, cat: Category): Promise<void> => {
        const st = fields.get(el)
        if (!st) return
        const goals = getConfig().goals
        const visible = visibleItems(st.items, st.phase, goals)
        await applyBatchFor(el, visible.filter((it) => it.category === cat))
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
            // W3-3 follow-up: a paused composer must not show a stale
            // streaming scan-line. Reset phase so renderField's scan-line
            // gate (mount on 'fast' / remove on 'done') tears it down.
            // Mirrors the browser's catch path which sets both items=[]
            // AND phase='done' atomically.
            st.phase = 'done'
            renderField(el, st)
        }
        // Refresh the pill (disabled: paused) so the surface reflects the
        // new state. The W2b review panel keeps its own snapshot and
        // is independent of the pill; update runs unconditionally.
        if (pillHandle && pillHandle.isMounted()) {
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

    // Selection tracer: logs every document selectionchange whose selection
    // touches a tracked composer, with flat offsets + the active element.
    // This is the instrument that shows WHO moves the caret and WHEN
    // (user click vs Slate re-assertion after an apply). Dedupes identical
    // consecutive states to keep the log readable.
    let lastSelectionTrace = ''
    const onSelectionChange = (): void => {
        if (!getConfig().debugLogging) return
        const active = document.activeElement
        for (const el of trackedFields) {
            const info = selectionDebugInfo(el)
            if (info === 'no-selection' || info === 'outside-composer') continue
            const line = `${info} active=${active instanceof HTMLElement ? active.tagName : 'none'}`
            if (line === lastSelectionTrace) return
            lastSelectionTrace = line
            debugLog('selectionchange', line)
            return
        }
    }
    document.addEventListener('selectionchange', onSelectionChange)
    cleanups.push(() => document.removeEventListener('selectionchange', onSelectionChange))

    const armPasteGrace = (el: HTMLElement, st: FieldState, attachment: FieldAttachment): void => {
        attachment.cancelPending()
        clearPasteGrace(st)
        st.pasteGraceTimer = setTimeout(() => {
            st.pasteGraceTimer = null
            void rerunFor(el)(getText(el))
        }, PASTE_GRACE_MS)
    }

    // Mirror of the browser orchestrator's applyScopedClearToField. The
    // shared keep helper decides which items survive; we hide the dropped
    // ones in place via the per-item primitive so the survivors don't
    // flicker. (Vencord is contenteditable-only → no native path; the
    // native branch from the browser helper is omitted here.)
    const applyScopedClearToField = (
        st: FieldState,
        _el: HTMLElement,
        kept: readonly RenderableItem[],
    ): void => {
        if (st.items.length === kept.length) return
        // Mirror of the browser orchestrator's wire-up. The per-item
        // clearItem loop + the null-caret short-circuit live in
        // @/lib/scoped-clear so the Finding 5 fast path is testable
        // in isolation. (Vencord is contenteditable-only → no native
        // path; the browser helper's native branch is omitted here.)
        const layer = st.highlightLayer as unknown as
            | { clearItem(i: number): void; reconcile(s: readonly never[]): void }
            | undefined
        if (layer) applyScopedOverlayClear(layer, st.items, kept)
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
            // Spec §4 sibling: popover closes on input edit. The popover
            // points at a highlight we may be about to clear. Close it
            // unconditionally on any input event (paste / typing / drop)
            // — better no popover than a ghost-anchored one.
            closePopoverFor(el)
            if (decision === 'check') {
                // Spec §3: scoped-clear BEFORE the debounced check
                // returns. Mirrors the browser orchestrator's
                // onInputEventFor.
                clearPasteGrace(st)
                const editOffset = getCaretOffset(el)
                const kept = keepHighlightsBeforeEdit(st.items, editOffset)
                if (kept.length < st.items.length) {
                    applyScopedClearToField(st, el, kept)
                }
                st.items = kept
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
            // Process-monotonic: a re-attached composer's first seq is
            // strictly greater than any seq a torn-down composer ever
            // produced. Mirrors the browser fix; see @/lib/check-seq.
            checkSeq: nextCheckSeq(),
            pasteGraceTimer: null,
            highlightLayer: null,
            hoverItemIndex: null,
            lastApplied: null,
            // Initial phase is 'done' so a freshly-attached field with
            // no check yet renders an empty pill cleanly; the first
            // check transitions fast → done and the orb updates.
            phase: 'done',
            // W3-3 follow-up: scan-line is mounted on first `phase === 'fast'`.
            scanlineHandle: null,
        }
        fields.set(el, st)
        trackedFields.add(el)
        lastActiveField = el
        notify()

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
            // Hide the hover preview before opening the full popover so the
            // two surfaces never overlap (mirrors browser client's click handler).
            hideTooltipNow()
            openPopoverFor(el, hit.item, hit.rect)
        }
        el.addEventListener('click', onFieldClick)
        cleanups.push(() => el.removeEventListener('click', onFieldClick))

        // W3-3: double-click on a NON-flagged word → synonyms popover.
        // Mirror of the browser's dblclick handler in
        // clients/browser/src/entrypoints/content/index.ts. The browser
        // resolves the word via caretPositionFromPoint + resolveWordAtPoint
        // and fetches /synonyms; we reuse both via the shared `@/overlay/
        // synonyms` module. The apply is via applySlateFix (NEVER innerHTML)
        // + an Undo toast + an 'accepted' signal. Pasted text is excluded
        // from checks; we don't add the same exclusion to synonyms — the
        // user explicitly chose to dblclick.
        const onFieldDblClick = (e: MouseEvent): void => {
            if (paused) return
            const text = getText(el)
            if (!text) return
            const resolved = resolveWordFromDblClick(e, text, el)
            if (!resolved) return
            const s = fields.get(el)
            if (!s) return
            // Skip dblclicks that land on a flagged word (the existing
            // single-click popover owns those; a synonyms popover would
            // overlap visually).
            const flaggedAt = s.items.find(
                (it) => resolved.start < it.cuEnd && resolved.end > it.cuStart,
            )
            if (flaggedAt) return
            // Show the popover immediately in the loading state, then
            // swap the body with the loaded synonyms (or empty). The
            // shared showSynonyms owns the loading spinner + the
            // pick-list render.
            const wordRect = measureWordRect(el, text, resolved.start, resolved.end)
            if (!wordRect) return
            hideTooltipNow()
            closeSynonyms()
            synonymsHandle = showSynonyms(overlay.root, {
                anchorRect: wordRect,
                word: resolved.word,
                synonyms: [],
                loading: true,
                onPick: (synonym) => {
                    void applySynonym(el, resolved, synonym)
                },
                onClose: () => {
                    synonymsHandle?.destroy()
                    synonymsHandle = null
                },
            })
            // Fetch in the background; the surface re-mounts on resolve
            // so the loading state is replaced with the loaded list.
            refreshClient()
                .synonyms(resolved.word)
                .then((res) => {
                    if (!synonymsHandle) return
                    synonymsHandle.destroy()
                    synonymsHandle = showSynonyms(overlay.root, {
                        anchorRect: wordRect,
                        word: resolved.word,
                        synonyms: res.synonyms,
                        loading: false,
                        onPick: (synonym) => {
                            void applySynonym(el, resolved, synonym)
                        },
                        onClose: () => {
                            synonymsHandle?.destroy()
                            synonymsHandle = null
                        },
                    })
                })
                .catch((err) => {
                    debugLog('synonyms fetch failed', err)
                    if (!synonymsHandle) return
                    synonymsHandle.destroy()
                    synonymsHandle = showSynonyms(overlay.root, {
                        anchorRect: wordRect,
                        word: resolved.word,
                        synonyms: [],
                        loading: false,
                        onPick: (synonym) => {
                            void applySynonym(el, resolved, synonym)
                        },
                        onClose: () => {
                            synonymsHandle?.destroy()
                            synonymsHandle = null
                        },
                    })
                })
        }
        el.addEventListener('dblclick', onFieldDblClick)
        cleanups.push(() => el.removeEventListener('dblclick', onFieldDblClick))

        // Hover preview: mousemove hit-tests the pointer against itemRects and
        // shows a lightweight tooltip chip (diff only, no buttons). Only updates
        // when the hovered item index CHANGES so the tooltip doesn't thrash.
        // mouseleave hides the tooltip and resets hoverItemIndex.
        // Mirrors the browser client's onFieldMouseMove / onFieldMouseLeave.
        const onFieldMouseMove = (e: MouseEvent): void => {
            if (paused) return
            const s = fields.get(el)
            if (!s || s.items.length === 0) return
            const { index, changed } = hoverDecision(
                s.itemRects,
                e.clientX,
                e.clientY,
                s.hoverItemIndex,
            )
            if (changed) {
                s.hoverItemIndex = index
                s.highlightLayer?.setState({
                    focused: document.activeElement === el,
                    hoverItemIndex: index,
                })
            }
            if (!changed) return
            if (index === null) {
                activeTooltip?.hide()
                activeTooltip = null
                activeTooltipItem = null
                return
            }
            // Already previewing this exact item: keep it open (no thrash).
            if (activeTooltipItem === s.items[index] && activeTooltip?.isOpen()) return
            const item = s.items[index]!
            activeTooltipItem = item
            activeTooltip = showTooltip(overlay.root, {
                anchorRect: s.itemRects[index]!.rects[0] ?? new DOMRect(),
                category: item.category,
                diffOriginal: item.diffOriginal,
                diffCorrected: item.diffCorrected,
                diffIsDeletion: item.diffIsDeletion,
            })
        }
        const onFieldMouseLeave = (): void => {
            const s = fields.get(el)
            if (s && s.hoverItemIndex !== null) {
                s.hoverItemIndex = null
                s.highlightLayer?.setState({
                    focused: document.activeElement === el,
                    hoverItemIndex: null,
                })
            }
            hideTooltipNow()
        }
        el.addEventListener('mousemove', onFieldMouseMove)
        el.addEventListener('mouseleave', onFieldMouseLeave)
        cleanups.push(() => {
            el.removeEventListener('mousemove', onFieldMouseMove)
            el.removeEventListener('mouseleave', onFieldMouseLeave)
        })

        // Focus-flow tracing for the caret-jump investigation: log every
        // focus hand-off involving the composer, with where focus went/came
        // from and the live selection state (Slate restores a remembered
        // selection on refocus — the suspected jump mechanism).
        const describeNode = (n: EventTarget | null): string => {
            if (!(n instanceof HTMLElement)) return String(n)
            return `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 50)}`
        }
        // Input-event tracer: shows EVERY beforeinput/input on the composer
        // with inputType, isTrusted (distinguishes our synthetic apply event
        // from real typing / Slate-internal events), data, and target ranges
        // resolved to flat offsets. The caret-jam investigation needs to see
        // exactly what reaches the editor and in what order.
        const traceInputEvent = (label: string) => (e: Event) => {
            if (!getConfig().debugLogging) return
            const ie = e as InputEvent
            let targetRanges = 'n/a'
            try {
                const ranges = ie.getTargetRanges?.() ?? []
                targetRanges = ranges
                    .map((r) => {
                        const s = domPointToFlatOffset(el, r.startContainer, r.startOffset)
                        const en = domPointToFlatOffset(el, r.endContainer, r.endOffset)
                        return `[${String(s)},${String(en)})`
                    })
                    .join(',')
            } catch {
                targetRanges = 'threw'
            }
            debugLog(label, {
                inputType: ie.inputType ?? '',
                trusted: e.isTrusted,
                data: typeof ie.data === 'string' ? JSON.stringify(ie.data.slice(0, 30)) : null,
                targetRanges,
                selection: selectionDebugInfo(el),
            })
        }
        const traceBeforeInput = traceInputEvent('ev beforeinput')
        const traceInput = traceInputEvent('ev input')
        el.addEventListener('beforeinput', traceBeforeInput, { capture: true })
        el.addEventListener('input', traceInput, { capture: true })
        cleanups.push(() => {
            el.removeEventListener('beforeinput', traceBeforeInput, { capture: true })
            el.removeEventListener('input', traceInput, { capture: true })
        })

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

        // Spec §4 sibling: blur → clear highlights + close popover. The
        // browser orchestrator has this; the Vencord orchestrator only
        // had the debug focus tracer (onFieldFocusOut above). Add the
        // real one. Vencord is contenteditable-only (no native path).
        const onFieldBlur = (e: FocusEvent): void => {
            // When the user clicks a suggestion in our popover, the browser
            // fires a11y focus onto the Apply button (inside our shadow-DOM
            // overlay). The composer's blur event fires with relatedTarget
            // retargeted to the overlay host. Guard against this: if focus
            // moved INTO our own overlay, keep all highlights and the popover
            // — this is a focus STEAL we triggered, not a genuine field-exit.
            if (isWithinOverlay(e.relatedTarget)) return
            const s = fields.get(el)
            if (!s) return
            // Hide the hover tooltip on genuine field exit (mirrors browser
            // client's hideTooltipNow call in onFieldBlur).
            hideTooltipNow()
            closePopoverFor(el)
            s.items = []
            s.itemRects = []
            s.hoverItemIndex = null
            s.highlightLayer?.reconcile([])
            // W3-3 follow-up: a blur during phase='fast' would otherwise
            // leave the streaming scan-line wrapper anchored to a stale
            // field rect (the user is no longer looking at the field).
            // Tear it down + reset phase so the next focus + check cycle
            // starts clean. Consistent with detach + togglePause + the
            // stream-error catch path. removeScanline is idempotent.
            if (s.scanlineHandle) {
                removeScanline(s.scanlineHandle)
                s.scanlineHandle = null
            }
            s.phase = 'done'
        }
        el.addEventListener('blur', onFieldBlur)
        cleanups.push(() => el.removeEventListener('blur', onFieldBlur))

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
        // Hide the hover tooltip if it was anchored to this field (mirrors
        // browser client's hideTooltipNow call in detach).
        if (activeTooltipItem && st.items.includes(activeTooltipItem)) {
            hideTooltipNow()
        }
        st.highlightLayer?.destroy()
        st.highlightLayer = null
        openPopovers.get(el)?.hide()
        openPopovers.delete(el)
        // W3-3 follow-up leak fix: the Vencord orchestrator never calls
        // st.attachment.setHandles(), so the attachment's scanlineDestroy
        // slot is undefined and st.attachment.detach() cannot reach the
        // live scan-line. Teardown is explicit: a field that switches
        // channels mid-fast-frame (no check in flight, so rerunFor's
        // !el.isConnected branch never fires) would otherwise orphan a
        // fixed-position wrapper inside the overlay host — a stuck sweep
        // over Discord until stop(). removeScanline is idempotent so a
        // re-detach is a no-op.
        if (st.scanlineHandle) {
            removeScanline(st.scanlineHandle)
            st.scanlineHandle = null
        }
        st.attachment.detach()
        trackedFields.delete(el)
        fields.delete(el)
        if (lastActiveField === el) {
            lastActiveField = null
            // Refresh the pill if it was anchored to the detached field.
            // Use the new active composer (or null → no active pill).
            const next = activeComposer()
            if (pillHandle && pillHandle.isMounted()) {
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
        // Rephrase hotkey (capture phase). Runs BEFORE the items.length
        // gate — the rephrase hotkey must fire on a focused tracked field
        // even when there are no active suggestions (selection-in-el or
        // whole-field). The matchers are distinct by default (Ctrl+/ vs
        // Ctrl+.) so order is documentation, not a tie-breaker.
        try {
            if (
                shouldRephraseHotkey(e, {
                    hotkey: getConfig().rephraseHotkey,
                })
            ) {
                e.preventDefault()
                e.stopPropagation()
                rephraseFor(field)
                return
            }
        } catch (err) {
            // parseHotkey throws on a malformed configured string; a broken
            // setting must not turn every keystroke into an uncaught error.
            debugLog('rephrase hotkey parse failed', getConfig().rephraseHotkey, err)
        }
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
        if (first) void applyItem(field, first)
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    cleanups.push(() => document.removeEventListener('keydown', onKeydown, { capture: true }))

    // Track panel state transitions for the pill. The local `panelOpen`
    // mirror lets hidePill / renderField skip the pill update while the
    // W2b review panel is open (an update() during that window would
    // close the panel). The flag is flipped in three places:
    //   - `togglePanel` when the chatbar button / pill body opens or
    //     dismisses the review panel (the W2b showPanel returns a handle
    //     and the panel's own `onClose` callback resets the flag);
    //   - the panel's `onClose` callback (the user clicks the head × or
    //     hits Esc on the panel);
    //   - `stop()` on teardown (the overlay is being torn down — clear
    //     the flag so any leaked renderField call doesn't skip the pill).
    // There is no pill-side proxy — the W2b review panel owns its own
    // open/close lifecycle via showPanel(overlay.root, ...).

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
            // Hide the hover tooltip on teardown (mirrors browser client).
            hideTooltipNow()
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
