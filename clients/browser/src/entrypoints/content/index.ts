// Content-script orchestrator. The SOLE wirer (spec §3): input -> api ->
// overlay -> signal, plus the accept hotkey, the on-demand TRIGGER_CHECK
// message handler, and the TAB_STATUS reply consumed by the popup. Plain TS
// + native DOM in an open shadow root (no React — MV3 startup budget).
// Every timer and listener is registered with `ctx` so teardown happens
// automatically on script invalidation.
//
// All non-trivial logic lives in the lower layers; this file is wiring. The
// pipeline (buildRenderableItems + verifyByteSpan + deriveCategory + isSpanStillValid)
// keeps the per-text transform pure and testable in @/lib/pipeline.

import { createFieldObserver } from '@/input/observer'
import { isEditableElement } from '@/input/detector'
import { createFieldAttachment, type FieldAttachment } from '@/input/attachment'
import { isPasteInput, shouldCheckInput } from '@/input/paste-guard'
import { isUndoRedoKeydown } from '@/input/undo-redo'
import { applyFix, domPointToFlatOffset, getText } from '@/input/text'
import { getCaretOffset, keepHighlightsBeforeEdit } from '@/input/caret-offset'
import { nextCheckSeq } from '@/lib/check-seq'
import { mountRephraseFlow, resolveSelection as resolveRephraseSelectionFor } from './rephrase'
import { mountPausedMode, nextPauseMode } from './pause'
import { mountReanchor } from './reanchor'
import { isFrameworkRichEditor } from '@/input/rich-editor-apply'
import { requestMainWorldApply } from '@/input/main-world-apply'
import { appendInverseEdit, planUndo, type InverseEdit } from '@/lib/undo'
import {
    buildRenderableItems,
    isSpanStillValid,
    tallyByCategory,
    type RenderableItem,
} from '@/lib/pipeline'
import { applyScopedOverlayClear } from '@/lib/scoped-clear'
import { isMessage, type GfMessageMap } from '@/messaging/schema'
import {
    computeScore,
    highConfidenceItems,
    scoreBand,
    visibleItems,
} from '@/lib/view-model'
import { createOverlayHost, isWithinOverlay } from '@/overlay/shadow-host'
import { getSpanRectsBatch } from '@/overlay/rect'
import { createHighlightLayer, type HighlightSpec } from '@/overlay/highlight'
import { getNativeHighlighter, isNativeHighlightSupported } from '@/overlay/native-highlight'
import { dismissPopoversIn, showPopover, type PopoverHandle } from '@/overlay/popover'
import { showTooltip, type TooltipHandle } from '@/overlay/tooltip'
import { showToast } from '@/overlay/toast'
import { dismissRephraseButtonsIn } from '@/overlay/rephrase-button'
import { dismissRephraseCardsIn } from '@/overlay/rephrase-card'
import {
    renderStatusButton,
    type StatusButtonHandle,
    type StatusButtonOptions,
} from '@/overlay/status-button'
import { showPanel, type PanelHandle, type PanelOptions } from '@/overlay/panel'
import { showGoals, type GoalsHandle } from '@/overlay/goals'
import { mountStatsView, type StatsViewHandle } from '@/overlay/stats-view'
import {
    resolveWordFromDblClick,
    showSynonyms,
    type SynonymsHandle,
} from '@/overlay/synonyms'
import { BridgeClient } from '@/api/client'
import { createSignalQueue, type SignalQueue } from '@/signal/queue'
import {
    getSettings,
    isSiteBlocked,
    setSettings,
    settingsItem,
    type Settings,
} from '@/storage/settings'
import { shouldAcceptHotkey } from '@/hotkeys/accept'
import { handleRephraseHotkey } from './keydown-rephrase'
import { debugLog, debugWarn, setDebugLoggingEnabled } from '@/lib/debug-log'
import type { ContentScriptContext } from 'wxt/utils/content-script-context'
import type { Category, CorrectResponse } from '@/api/types'

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',
    main(ctx) {
        void start(ctx)
    },
})

/** Map a DOM Selection range to a [start,end) code-unit span on el's flat
 *  text (the same line-aware model applyFix/getText use). Endpoints resolve
 *  via domPointToFlatOffset — NOT Range.toString(), which (like textContent)
 *  omits the virtual newlines at block boundaries and would disagree with
 *  the flat model on any multi-line selection. Unresolvable endpoints yield
 *  a collapsed {0,0} span, which every caller discards as empty. */
export function selectionToCodeUnitSpan(
    el: HTMLElement,
    range: Range,
): { start: number; end: number } {
    const start = domPointToFlatOffset(el, range.startContainer, range.startOffset)
    const end = domPointToFlatOffset(el, range.endContainer, range.endOffset)
    if (start == null || end == null || end < start) return { start: 0, end: 0 }
    return { start, end }
}

interface FieldState {
    /**
     * The per-field lifecycle owner. Owns the input/blur listeners, the
     * trailing-edge debouncer, and (via `setHandles`) the destroy hooks
     * for whatever overlay elements are currently mounted. Calling
     * `attachment.detach()` releases everything bound to this field —
     * wired to the observer's onFieldDetached callback so chatty SPAs
     * that churn editable fields don't leak listeners.
     */
    attachment: FieldAttachment
    /** Latest runCheck result, used to render highlights + status pill. */
    items: RenderableItem[]
    /**
     * Per-item viewport rects from the LAST render, parallel to (a subset of)
     * `items`. The field-level hover/click hit-test maps a pointer position to
     * the edit under it via these rects. Rebuilt on every renderField; [] when
     * there are no suggestions.
     */
    itemRects: Array<{ item: RenderableItem; rects: DOMRect[] }>
    /**
     * Monotonic check counter. Each rerunFor call takes the next value before
     * its async bridge request; when the request resolves it only renders if it
     * is STILL the latest (its value equals checkSeq). Drops stale results from
     * overlapping checks — e.g. applying a fix fires both a direct re-check and
     * the edit-event debounced re-check; without this, an older check (text
     * still had an error) could resolve last and leave the pill showing a stale
     * count.
     */
    checkSeq: number
    /**
     * Active paste-grace timer, or null. On a paste/drop we suppress the
     * immediate grammar check and arm this timer (settings.pasteGraceMs) so the
     * user can edit the pasted text BEFORE GrammarForge flags it. The timer
     * fires the check on expiry; a non-paste edit clears it and checks
     * immediately (whichever comes first). Re-armed on each paste. Always
     * cleared on field detach / runtime teardown so it never fires against a
     * torn-down overlay.
     */
    pasteGraceTimer: ReturnType<typeof setTimeout> | null
    /**
     * Persistent reconciling highlight layer for this field (created lazily on
     * first render; reused across checks so nodes aren't destroyed+recreated).
     */
    highlightLayer: import('@/overlay/highlight').HighlightLayer | null
    /**
     * Index of the item the pointer is currently hovering (parallel to
     * state.items), or null when nothing is hovered. Drives the per-word
     * highlight intensity via highlightLayer.setState({hoverItemIndex}).
     */
    hoverItemIndex: number | null
    /**
     * True when this field renders highlights via the document-global
     * CSS Custom Highlight API (contenteditable, when the API is
     * available). False for textarea/input, or as a fallback when the API
     * is missing — those fields use the per-field overlay layer
     * (state.highlightLayer) instead.
     */
    useNativeHighlight: boolean
    /**
     * The live status-pill handle from the LAST renderField, or null before
     * the first render. The shared scroll/resize loop calls
     * `statusHandle.reposition(el.getBoundingClientRect())` so the pill tracks
     * its field (re-anchoring with the live drag offset) instead of staying
     * pinned while the field scrolls away. Replaced on each render; the prior
     * pill is destroyed by the attachment's setHandles swap.
     */
    statusHandle: StatusButtonHandle | null
    /**
     * Restore this field's ORIGINAL `spellcheck` attribute (recorded at attach).
     * Run on detach so a field reused by a chatty SPA isn't left with our
     * `spellcheck="false"`. Also pushed onto runtime.cleanups for teardown.
     */
    restoreSpellcheck: () => void
    /**
     * Last apply action's inverse edits (single undo slot; a new apply
     * overwrites it, undo consumes it). null = nothing to undo. Lives on
     * the field (not the runtime) so a settings-driven teardown doesn't
     * lose it, and so different fields don't share an undo queue.
     */
    lastApplied: InverseEdit[] | null
    /**
     * W3-2: per-field writing goals (audience + formality + domain).
     * Seeded from settings on attach; updated when the user edits goals
     * via the panel's Goals popover (the orchestrator patches settings
     * and re-renders the field). Used by the panel's `visibleItems`
     * filter (informal mutes style) + the muted-style note + the
     * rephrase default tone.
     */
    goals: import('@/api/types').Goals
    /**
     * W3-1: the streaming phase of the LATEST check. `'done'` is the
     * stable post-LLM state; `'fast'` is the local-only preview frame.
     * Drives the orb's pip center glyph (sparkle → count) and the
     * panel's streaming banner. Settles to `'done'` on the final frame
     * or on a clear-all (no items).
     */
    phase: import('@/api/types').Phase
}

interface ActiveSuggestion {
    el: HTMLElement
    item: RenderableItem
    replacementIndex: number
}

interface Runtime {
    client: BridgeClient
    signalQueue: SignalQueue
    overlay: ReturnType<typeof createOverlayHost>
    active: ActiveSuggestion | null
    fields: WeakMap<HTMLElement, FieldState>
    /**
     * ALL editable fields currently attached (native + overlay), for the
     * SHARED scroll/resize remeasure loop. Iterable (unlike `fields`, a
     * WeakMap) so one shared listener can re-process them all. Every tracked
     * field needs per-scroll work: overlay fields re-measure their span rects
     * + reconcile highlights; native fields re-measure their hit-test rects
     * (the CSS Custom Highlight visuals self-track, but `state.itemRects` —
     * used by the hover/click hit-test — would otherwise go stale on scroll);
     * and BOTH re-anchor their status pill to the field via reposition.
     */
    trackedFields: Set<HTMLElement>
    /** Per-category counts for the FOCUSED field's last runCheck (used by the popup). */
    counts: Partial<Record<Category, number>>
    /** Total editable fields known to the observer (best-effort count). */
    fieldCount: number
    /** The single hover tooltip (one per overlay), or null when hidden. */
    tooltip: TooltipHandle | null
    /** Pending tooltip-hide grace timer, or null. Cleared on teardown. */
    hoverTimer: ReturnType<typeof setTimeout> | null
    /** The item the tooltip currently previews (avoids redundant re-renders). */
    hoverItem: RenderableItem | null
    /** The field the current chip belongs to; needed to clear our
     *  aria-describedby on the right element when the chip hides. */
    hoverField: HTMLElement | null
    /** The field whose click-popover is currently open, or null. Single-popover
     *  invariant across fields: opening a popover on field B closes any popover
     *  on field A. `openPopovers` is a WeakMap (not iterable), so this explicit
     *  back-reference lets openPopoverFor close the previous field's popover and
     *  detach/teardown clear it. */
    activePopoverField: HTMLElement | null
    /** W3-1: the SINGLE review-panel instance for the runtime (one
     *  panel at a time, regardless of how many fields are attached).
     *  A new `showPanel()` dismisses the prior via `destroyExisting`
     *  inside showPanel; the handle is updated so a later Stats-view
     *  mount can find the live body container. `null` between opens. */
    panelHandle: PanelHandle | null
    /** W3-1: the field the open review panel belongs to. The panel
     *  is anchored to the field's orb rect; the orchestrator reads
     *  this back-reference so the panel can re-anchor to the same
     *  field's rect on a settings/Goals change. */
    panelField: HTMLElement | null
    /** W3-1: the active Goals popover (one at a time, anchored to
     *  the panel's Goals pill rect). `null` when closed. */
    goalsHandle: GoalsHandle | null
    /** W3-1: the active Stats view (mounts INTO the panel's body
     *  slot via `panelHandle.getBodyContainer()`). `null` when the
     *  Stats tab isn't open. */
    statsHandle: StatsViewHandle | null
    /** W3-1: the active Synonyms popover (one at a time, anchored
     *  to a double-clicked clean word). `null` when closed. */
    synonymsHandle: SynonymsHandle | null
    /** W3-1: the FOCUSED field at the time the user opened the
     *  review panel. Re-anchor + re-render helpers use this to find
     *  the right state to refresh when goals change. */
    panelFor: HTMLElement | null
    stopObserver: (() => void) | null
    /**
     * Every remover that bound a listener to this runtime. teardownRuntime
     * iterates and runs them, so a disable→enable cycle on the same page
     * doesn't accumulate duplicate keydown / onMessage / locationchange /
     * per-field input+blur listeners. Listeners added via ctx.* are also
     * mirrored here so they go away on teardown (ctx.onInvalidated only
     * fires on script invalidation, NOT on a settings-driven teardown).
     */
    cleanups: Array<() => void>
}

async function start(ctx: ContentScriptContext): Promise<void> {
    // eslint-disable-next-line no-console
    console.info('[gf] content script loaded')
    let currentSettings: Settings = await getSettings()
    // Drive the verbose logger from the setting (null = fall back to the
    // localStorage.gfDebug manual override).
    setDebugLoggingEnabled(currentSettings.debugLogging ? true : null)
    const hostname = location.hostname
    // The extension is globally on/off via settings.enabled; per-site disable
    // ("power off on this site") lives in the blockedSites deny-list.
    // (The `extensionOn` and `sitePaused` predicates that used to live here
    // were absorbed into the pure `nextPauseMode` reducer in
    // ./pause.ts; reconcile() now calls that directly.)

    // Full checking runtime (exists only when on + site not paused). When the
    // site is paused we instead show a small standalone "power" pill so the
    // user can re-enable in-page (disabledHost).
    let runtime: Runtime | null = null
    // Paused-mode minimal runtime — field discovery + focus tracking only, no
    // checking, no bridge client. The off-pill anchors to the FOCUSED field
    // exactly like the active pill; the cleanups array is the single teardown
    // handle. null when paused mode isn't active.
    let pausedCleanups: Array<() => void> | null = null
    // The most-recently focused editable field, tracked for the WHOLE content
    // lifetime (both modes) by the persistent focusin listener below. Needed
    // because disabling via the pill's Power button moves focus onto that
    // button and then destroys it, leaving document.activeElement === <body>;
    // the freshly-mounted paused pill is focus-gated and would otherwise never
    // appear for the field the user was just editing (no in-page Enable). The
    // button is not editable, so it never overwrites this reference. Cleared
    // when the field leaves the DOM.
    let lastFocusedField: HTMLElement | null = null
    // Status-pill drag offset — kept in start() scope (NOT on the runtime) so
    // it survives a settings-driven teardown: dragging the pill, then disabling
    // the site, must keep the re-enable pill at the same drag offset (the
    // runtime, and anything on it, is destroyed on teardown). `dragOffset` is
    // the field-relative shift from the pill's default bottom-right anchor
    // (null until the user drags). A shared object so wireRuntime (where the
    // active pill renders) mutates the same state as the disabled pill here.
    const pillPosition: PillPosition = { dragOffset: null }

    const teardownRuntime = (): void => {
        if (!runtime) return
        // Mark inactive first so the script-invalidation onInvalidated
        // callback (also wired to this function) is a no-op the second time.
        const r = runtime
        runtime = null
        // 1. Remove every listener bound to this runtime. Order matters only
        //    in that removers must run before any further field/observer work
        //    (so a late-firing input event doesn't reach a torn-down runtime).
        for (const cleanup of r.cleanups) {
            try {
                cleanup()
            } catch {
                // A single failed remover must not block the rest of the
                // teardown — the page is going back to its unmonitored state.
            }
        }
        r.cleanups.length = 0
        // 2. Stop discovering new fields.
        r.stopObserver?.()
        r.stopObserver = null
        // 2b. Hide the hover tooltip + cancel its pending hide timer so the
        //     timer doesn't fire against a torn-down runtime. The tooltip node
        //     itself also goes away with the host in step 3, but the timer
        //     must be cleared explicitly.
        if (r.hoverTimer) {
            clearTimeout(r.hoverTimer)
            r.hoverTimer = null
        }
        r.tooltip?.hide()
        r.tooltip = null
        r.hoverItem = null
        // Clear the chip's aria-describedby off the PAGE field before dropping
        // the reference — the field survives a settings-driven teardown, so a
        // dangling aria-describedby="gf-chip" would point a screen reader at a
        // removed node. Guarded so we never clobber a page-owned value.
        if (r.hoverField && r.hoverField.getAttribute('aria-describedby') === 'gf-chip') {
            r.hoverField.removeAttribute('aria-describedby')
        }
        r.hoverField = null
        // 2c. Dismiss the review panel / Goals popover / Stats view /
        //     Synonyms popover if any are open. They are children of
        //     the overlay root so destroyExisting(dismiss) inside showPanel
        //     et al. would clean them up, but the runtime holds explicit
        //     handles for test introspection + for the "dismiss → signal"
        //     wiring. Explicit destroy is idempotent.
        r.synonymsHandle?.destroy()
        r.synonymsHandle = null
        r.goalsHandle?.destroy()
        r.goalsHandle = null
        r.statsHandle?.destroy()
        r.statsHandle = null
        r.panelHandle?.destroy()
        r.panelHandle = null
        r.panelField = null
        r.panelFor = null
        // 3. Tear down the DOM.
        r.overlay.destroy()
        // 3b. Destroy the document-global native highlighter too — it
        //     holds entries in the page's `CSS.highlights` registry and
        //     an injected `<style>` on the page; on a settings-driven
        //     teardown the page is going back to its unmonitored state
        //     and both must go away.
        getNativeHighlighter().destroy()
        // 4. Flush any pending feedback (best-effort).
        void r.signalQueue.flush()
        r.active = null
        r.counts = {}
        r.fieldCount = 0
    }

    const makeRuntime = (s: Settings): Runtime => {
        const client = new BridgeClient(s.bridgeBaseUrl, s.allowRemoteBridge)
        const signalQueue: SignalQueue = createSignalQueue({
            send: (events) => client.signal(events),
        })
        return {
            client,
            signalQueue,
            overlay: createOverlayHost(),
            active: null,
            fields: new WeakMap(),
            trackedFields: new Set(),
            counts: {},
            fieldCount: 0,
            tooltip: null,
            hoverTimer: null,
            hoverItem: null,
            hoverField: null,
            activePopoverField: null,
            panelHandle: null,
            panelField: null,
            goalsHandle: null,
            statsHandle: null,
            synonymsHandle: null,
            panelFor: null,
            stopObserver: null,
            cleanups: [],
        }
    }

    // Toggle the current site in the blockedSites deny-list (the pill's power
    // button). Persisted; the settings watcher below reconciles the UI
    // (teardown + show the re-enable pill, or re-init checking).
    const togglePower = async (): Promise<void> => {
        const s = await getSettings()
        const blocked = isSiteBlocked(s, hostname)
        const blockedSites = blocked
            ? s.blockedSites.filter((h) => h !== hostname)
            : [...s.blockedSites, hostname]
        await setSettings({ blockedSites })
    }

    const initRuntime = (s: Settings): void => {
        if (runtime) return
        const r = (runtime = makeRuntime(s))
        // On (re-)enable, check the field the user was last editing right away
        // instead of waiting for the next keystroke. lastFocusedField is
        // tracked across BOTH modes (and while fully disabled), so it holds the
        // field in play when the user flips the extension/site back on — via
        // the popup toggle (field still focused) OR the pill Power button
        // (focus landed on <body> after the button was destroyed). null on
        // first page load (no focusin yet) => no initial check, behaviour
        // unchanged. The wired runtime fires the one-shot once the observer
        // re-attaches that exact field.
        const initialCheckField = lastFocusedField?.isConnected ? lastFocusedField : null
        wireRuntime(
            ctx,
            r,
            () => currentSettings,
            togglePower,
            pillPosition,
            initialCheckField,
            // W3-3b follow-up: same `pausedCleanups` source the active
            // runtime's status pill AND the paused pill read to decide
            // which mount to show. Re-read at every panel open so a
            // mid-session pause flip is reflected on the next showPanel.
            () => pausedCleanups !== null,
            // W3-2: wireRuntime registers a callback that start's
            // settings watcher can call to refresh every field's render
            // + re-open the panel on a goals change. Wire it in BOTH
            // directions so the closure captures the right `runtime`
            // and `reconcile` instances.
            (refresh) => {
                refreshOnGoalsChange = refresh
            },
        )
    }

    // W3-2: a settings-watcher-side hook that wireRuntime registers
    // when it mounts (and nulls on teardown). The hook re-renders
    // every field AND re-opens the review panel with the new goals.
    // Lives in start() scope so the closure survives a settings-driven
    // teardown of wireRuntime (re-mounted runtimes re-register the hook).
    let refreshOnGoalsChange: (() => void) | null = null

    // Paused-site mode: a MINIMAL runtime — field discovery + focus tracking
    // only (no checking, no bridge, no highlights). Extracted to
    // ./pause.ts (Task 4b-2). The orchestrator owns the pause lifecycle
    // (mount / unmount / reducer state) and the module does the IO.
    const mountPausedModeLocal = (): void => {
        if (pausedCleanups) return
        const flow = mountPausedMode({
            hostname,
            getLastFocusedField: () => lastFocusedField,
            setLastFocusedField: (el) => {
                lastFocusedField = el
            },
            getDragOffset: () => pillPosition.dragOffset ?? undefined,
            setDragOffset: (offset) => {
                pillPosition.dragOffset = offset ?? null
            },
            onTogglePower: () => togglePower(),
        })
        pausedCleanups = [flow.stop]
    }
    const unmountPausedMode = (): void => {
        if (!pausedCleanups) return
        for (const c of pausedCleanups) {
            try {
                c()
            } catch {
                /* teardown is best-effort */
            }
        }
        pausedCleanups = null
    }

    // Persistent focused-field tracker (BOTH modes, whole content lifetime).
    // Records the editable field receiving focus so paused mode can anchor its
    // pill to the field the user was last editing even when focus has since
    // landed on <body> (e.g. right after the Power button that triggered the
    // disable was destroyed). Non-editable targets (the pill's own buttons) are
    // ignored, so the reference survives the disable gesture.
    const trackFocus = (e: FocusEvent): void => {
        const t = e.target
        if (t instanceof HTMLElement && isEditableElement(t)) lastFocusedField = t
    }
    document.addEventListener('focusin', trackFocus)
    ctx.onInvalidated(() => document.removeEventListener('focusin', trackFocus))

    // Reconcile the page state to the current settings. Reducer-driven via
    // nextPauseMode (./pause.ts): the same function the unit test pins.
    // mode='off'  → tear down everything (globally disabled)
    // mode='site-paused' → swap the full runtime for the minimal paused pill
    // mode='active' → (re)mount the full runtime
    const reconcile = (s: Settings): void => {
        const next = nextPauseMode(s, hostname)
        if (next.mode === 'off') {
            teardownRuntime()
            unmountPausedMode()
            return
        }
        if (next.mode === 'site-paused') {
            teardownRuntime()
            mountPausedModeLocal()
            return
        }
        unmountPausedMode()
        initRuntime(s)
    }

    // Settings watcher — rebind the bridge client when the URL/remote opt-in
    // changes, then reconcile the runtime/pill to the new settings. Per-check
    // flags (checkPastedText, picky, checkMode) are read live from the closure.
    const unwatchSettings = settingsItem.watch((next) => {
        const prev = currentSettings
        currentSettings = next
        setDebugLoggingEnabled(next.debugLogging ? true : null)
        if (
            runtime &&
            (prev.bridgeBaseUrl !== next.bridgeBaseUrl ||
                prev.allowRemoteBridge !== next.allowRemoteBridge)
        ) {
            // Recreate the client + signal queue's sender so a remote opt-out
            // takes effect immediately (the queue's `send` closes over the OLD
            // client; rebind it).
            const newClient = new BridgeClient(next.bridgeBaseUrl, next.allowRemoteBridge)
            runtime.client = newClient
            runtime.signalQueue = createSignalQueue({ send: (events) => newClient.signal(events) })
        }
        // A spellcheck-suppression flip must re-attach fields so the attribute
        // is applied/restored. The cheapest correct path is a full runtime
        // rebuild (teardown restores every field's original attribute, re-init
        // re-applies under the new setting).
        if (runtime && prev.suppressNativeSpellcheck !== next.suppressNativeSpellcheck) {
            teardownRuntime()
        }
        // W3-2: a goals change must propagate to every attached field's
        // local `state.goals` AND trigger a fresh render. The refresh
        // hook is registered by wireRuntime (it has access to the
        // per-runtime `renderField` + `openReviewPanelFor`); start() can't
        // see those directly. When no runtime is mounted (off / paused),
        // the next reconcile cycle wires the new goals from
        // currentSettings.goals on attach.
        if (runtime && prev.goals !== next.goals) {
            refreshOnGoalsChange?.()
        }
        reconcile(next)
    })
    ctx.onInvalidated(() => unwatchSettings())

    reconcile(currentSettings)

    // Script-invalidation teardown is the SAME as a settings-driven teardown:
    // every listener we registered is on `runtime.cleanups` (we mirror the
    // ctx.onInvalidated removers there too), so calling teardownRuntime
    // here releases everything. The function is idempotent — the `runtime =
    // null` guard makes a second call (e.g. if a settings-driven teardown
    // already ran) a no-op.
    ctx.onInvalidated(() => {
        teardownRuntime()
        unmountPausedMode()
    })
}

/**
 * Session status-pill position, shared between start() (the disabled re-enable
 * pill) and wireRuntime (the active per-field pill) so a dragged spot persists
 * across the enabled↔disabled swap and re-renders. Lives in start() scope so it
 * survives a settings-driven runtime teardown.
 */
interface PillPosition {
    /** Field-relative drag offset (dx,dy) from the pill's default bottom-right
     *  anchor; null until the user drags the pill. Applied on render AND on
     *  every scroll/resize remeasure (via statusHandle.reposition) so the pill
     *  tracks its field. */
    dragOffset: { dx: number; dy: number } | null
}

function wireRuntime(
    ctx: ContentScriptContext,
    runtime: Runtime,
    getSettings: () => Settings,
    togglePower: () => void,
    pillPosition: PillPosition,
    initialCheckField: HTMLElement | null,
    /** W3-3b follow-up: same `pausedCleanups` source the active runtime's
     *  status pill AND the paused pill read to decide which mount to show.
     *  start() owns `pausedCleanups` (wireRuntime can't see start()'s
     *  scope), so it passes a getter. The panel's `disabled` prop reads
     *  this to render the paused empty-state when the user opens the
     *  panel while the site is paused. */
    isPaused: () => boolean = () => false,
    /** W3-2: register a callback the start() settings watcher calls on
     *  a goals change. wireRuntime wires up the closure (it has access
     *  to `renderField` + `openReviewPanelFor` which live inside
     *  wireRuntime's scope); start() can't see them directly, so the
     *  indirection is the only way to plumb a settings-side hook to
     *  the runtime-side refresh. The setter is called exactly once,
     *  immediately after wireRuntime returns. */
    setRefreshOnGoalsChange: (refresh: (() => void) | null) => void = () => {},
): void {
    const { overlay, signalQueue } = runtime

    // One-shot: the field to check immediately on (re-)enable (see initRuntime).
    // Consumed the first time `attach` re-discovers that exact field, so a
    // later attach of a different field doesn't trigger a spurious check.
    let pendingInitialCheck = initialCheckField

    // W3-2: build the goals-change refresh closure now (it captures
    // `renderField` + `openReviewPanelFor` references by closure, which
    // is the whole point of the indirection). Register with start()
    // BEFORE wireRuntime returns; the teardown path nulls it so a
    // later settings-driven teardown doesn't leak a stale closure.
    setRefreshOnGoalsChange(() => {
        for (const el of runtime.trackedFields) {
            const st = runtime.fields.get(el)
            if (!st) continue
            st.goals = getSettings().goals
            renderField(el, runtime.overlay.root, st)
            updateFocusedCounts(runtime, el)
        }
        if (runtime.panelHandle && runtime.panelFor) {
            const el = runtime.panelFor
            runtime.panelHandle.destroy()
            runtime.panelHandle = null
            openReviewPanelFor(el)
        }
    })
    runtime.cleanups.push(() => setRefreshOnGoalsChange(null))

    // ---- Hover-tooltip lifecycle (shared across fields; one tooltip at a
    // time). The tooltip itself holds no listeners/timers — the grace-delay
    // hide timer lives here on the runtime so teardown can cancel it.
    const HOVER_THROTTLE_MS = 250
    const TOOLTIP_HIDE_GRACE_MS = 150
    // Minimum delay before reading a field's text after a paste, so rich editors
    // (Lexical/Discord) that apply the paste ASYNC have reconciled. Also the
    // floor for the paste-grace window (a user-configured grace below this would
    // read pre-paste text).
    const PASTE_SETTLE_MS = 150

    const clearTooltipHide = (): void => {
        if (runtime.hoverTimer) {
            clearTimeout(runtime.hoverTimer)
            runtime.hoverTimer = null
        }
    }

    // Route framework rich editors (Slate/Lexical) through the async
    // synthetic-replacement apply (see input/rich-editor-apply.ts — verified
    // live: the sync selection+execCommand path jams Slate's selection
    // bookkeeping). textarea/input/plain contenteditables keep the sync
    // applyFix path unchanged.
    const applyEdit = async (
        el: HTMLElement,
        span: { start: number; end: number },
        replacement: string,
    ): Promise<void> => {
        // Framework rich editors (Slate/Lexical) need the synthetic-
        // replacement apply, and it only works from the PAGE world: the
        // getTargetRanges override is invisible across the isolated-world
        // boundary (verified live on discord.com web — the page's Slate read
        // empty target ranges and inserted every edit at its model
        // selection, garbling apply-all). Route through the MAIN-world
        // agent (entrypoints/apply-agent.content.ts); a false/timeout reply
        // (agent unsupported — Firefox — or not yet injected) falls back to
        // the legacy sync path, which works but carries the latent Slate
        // selection-jam risk.
        if (
            !(el instanceof HTMLTextAreaElement) &&
            !(el instanceof HTMLInputElement) &&
            isFrameworkRichEditor(el)
        ) {
            if (await requestMainWorldApply(el, span, replacement)) return
            debugWarn('apply', 'main-world apply unavailable; legacy fallback')
        }
        applyFix(el, span, replacement)
    }
    const clearChipAria = (el: HTMLElement): void => {
        // Don't clobber a page-owned aria-describedby — only clear it if WE
        // set it (and we only ever set the single id 'gf-chip').
        if (el.getAttribute('aria-describedby') === 'gf-chip') {
            el.removeAttribute('aria-describedby')
        }
    }
    const hideTooltipNow = (): void => {
        clearTooltipHide()
        const field = runtime.hoverField
        runtime.tooltip?.hide()
        runtime.tooltip = null
        runtime.hoverItem = null
        runtime.hoverField = null
        if (field) clearChipAria(field)
    }
    const scheduleTooltipHide = (): void => {
        clearTooltipHide()
        const field = runtime.hoverField
        runtime.hoverTimer = setTimeout(() => {
            runtime.hoverTimer = null
            runtime.tooltip?.hide()
            runtime.tooltip = null
            runtime.hoverItem = null
            runtime.hoverField = null
            if (field) clearChipAria(field)
        }, TOOLTIP_HIDE_GRACE_MS)
    }

    // Cancel a field's pending paste-grace timer (if any). Idempotent. Called
    // when a non-paste edit ends the grace early, on each re-arm, and on
    // detach / teardown so a stale timer never fires a check against a
    // torn-down overlay.
    const clearPasteGrace = (state: FieldState): void => {
        if (state.pasteGraceTimer != null) {
            clearTimeout(state.pasteGraceTimer)
            state.pasteGraceTimer = null
        }
    }

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const state = runtime.fields.get(el)
            if (!state) return
            if (!ctx.isValid) return
            if (!el.isConnected) {
                // Field left the DOM mid-check: clear its overlay + hit-test
                // rects. clearHandles() tears down EVERYTHING including the
                // persistent highlight (unlike a re-render setHandles swap,
                // which preserves it) so nothing lingers after the field is
                // gone.
                state.items = []
                state.itemRects = []
                state.attachment.clearHandles()
                updateFocusedCounts(runtime, el)
                return
            }
            // NOTE: we deliberately do NOT clear the overlay here. The prior
            // render's highlights stay visible during the (async) bridge call
            // and are swapped out atomically when renderField calls
            // setHandles(new) — which destroys the previous set. Clearing here
            // instead would blink the highlights off for the whole round-trip.
            const seq = ++state.checkSeq
            const s = getSettings()
            // Render one frame (fast preview or final). Stale frames are
            // dropped by the same seq guard as before; the fast frame and
            // final frame of one check share a seq, so the final always
            // supersedes its own preview but never a NEWER check's frames.
            const renderStage = (res: CorrectResponse, preview: boolean): void => {
                if (!ctx.isValid) return
                if (seq !== state.checkSeq) return
                const { items } = buildRenderableItems(text, res, {}, { preview })
                state.items = items
                // W3-1: the streaming phase drives the orb's pip
                // center-glyph (sparkle on 'fast' → count on 'done') and
                // the panel's "Fast results in · AI refining…" banner.
                // The phase is set on the field state BEFORE the render
                // so renderField reads the fresh value.
                state.phase = preview ? 'fast' : 'done'
                renderField(el, overlay.root, state)
                updateFocusedCounts(runtime, el)
            }
            try {
                const final = await runtime.client.correctStream(
                    { text, picky: s.picky, source: 'browser' },
                    (fast) => renderStage(fast, true),
                )
                renderStage(final, false)
            } catch (e) {
                // The bridge is unreachable, rejected the URL, or the stream
                // errored after the preview. Clear any preview underlines so
                // no un-actionable highlights linger, then surface nothing
                // intrusive (matches the previous behaviour).
                if (ctx.isValid && seq === state.checkSeq && state.items.some((i) => i.preview)) {
                    state.items = []
                    state.phase = 'done'
                    renderField(el, overlay.root, state)
                    updateFocusedCounts(runtime, el)
                }
                debugWarn('check', 'correct() failed', e)
            }
        }

    const checkFocusedField = async (): Promise<void> => {
        const el = document.activeElement
        if (!(el instanceof HTMLElement)) return
        const state = runtime.fields.get(el)
        if (!state) return
        await rerunFor(el)(getText(el))
    }

    // Arm (or re-arm) the paste-grace window for a field: suppress the check for
    // `pasteGraceMs`, then re-check the LIVE text. Cancels any pending debounce
    // (so typing just before the paste can't fire mid-grace) and any prior grace
    // timer. A minimum settle floor (PASTE_SETTLE_MS) ensures rich editors
    // (Lexical/Discord) that apply the paste ASYNC have reconciled before we read
    // the text — important when the grace is configured very short / 0. Used by
    // BOTH the input-gate paste branch (plain fields, which fire an
    // inputType='insertFromPaste' event) and the native `paste` listener (rich
    // editors, which apply paste programmatically and fire NO such input event).
    const armPasteGrace = (el: HTMLElement, state: FieldState): void => {
        const s = getSettings()
        clearPasteGrace(state)
        state.attachment.cancelPending()
        const graceMs = Math.max(s.pasteGraceMs, PASTE_SETTLE_MS)
        state.pasteGraceTimer = setTimeout(() => {
            state.pasteGraceTimer = null
            void rerunFor(el)(getText(el))
        }, graceMs)
    }

    // Decide whether an `input` event on `el` should schedule a check, and arm
    // the paste-grace window as a side effect. This is the SINGLE authoritative
    // input gate (passed to the attachment as onInputEvent — there is no longer
    // a separate capture-phase listener). It reads settings live so realtime /
    // paste-skip toggles take effect immediately. The actual text read happens
    // at debounce FIRE time inside the attachment (Fix 2), not here.
    //
    // Apply the scoped-clear to a field's highlight layer. The shared
    // `keep` helper decides which items survive; for every DROPPED item we
    // hide its pooled node (overlay) or rebuild the native buckets from
    // the kept list (native) so the stale display is gone, without
    // rebuilding the survivors. (Native uses setFieldHighlights rather
    // than per-item primitives because the surviving set may now span
    // different category buckets than the old one — e.g. 2 spelling
    // items, 1 dropped, 1 grammar item survives untouched; the only safe
    // thing is a full bucket rebuild from the kept set.)
    const applyScopedClearToField = (
        state: FieldState,
        el: HTMLElement,
        kept: readonly RenderableItem[],
    ): void => {
        if (state.items.length === kept.length) return
        if (state.useNativeHighlight) {
            getNativeHighlighter().setFieldHighlights(
                el,
                kept.map((it) => ({ cuStart: it.hlStart, cuEnd: it.hlEnd, category: it.category })),
            )
        } else {
            // Overlay path — the per-item clearItem loop + the
            // null-caret short-circuit live in @/lib/scoped-clear so
            // the Finding 5 fast path is testable in isolation.
            const layer = state.highlightLayer as unknown as
                | { clearItem(i: number): void; reconcile(s: readonly never[]): void }
                | undefined
            if (layer) applyScopedOverlayClear(layer, state.items, kept)
        }
    }

    // Paste-grace: on a paste/drop (when checkPastedText is on and
    // pasteGraceMs > 0) we DON'T check yet — we arm a per-field timer so the
    // user can edit the pasted text first. The check fires when that window
    // expires OR earlier on the next non-paste edit (whichever comes first);
    // each new paste re-arms it.
    const onInputEventFor =
        (el: HTMLElement) =>
        (inputType: string): boolean => {
            const s = getSettings()
            if (s.checkMode !== 'realtime') return false
            if (!shouldCheckInput(inputType, { checkPastedText: s.checkPastedText })) return false
            const state = runtime.fields.get(el)
            if (!state) return false
            // Popover stale anchor: the popover points at a highlight we
            // may be about to clear by the scoped-clear below. Close it
            // first so it doesn't ghost-anchor over a dropped item. Done
            // unconditionally on any input event (paste / typing / drop).
            if (openPopovers.has(el)) closePopoverFor(el)
            if (isPasteInput(inputType)) {
                // Plain field paste (fires inputType='insertFromPaste'): arm the
                // grace window instead of checking now, then suppress the
                // immediate debounced check.
                armPasteGrace(el, state)
                return false
            }
            // Non-paste edit: scoped-clear the stale highlights BEFORE the
            // debounced check fires (300–700 ms round-trip). Without this
            // the old underline sits at its old pixel position during the
            // window (Bug 1: sticky after Enter, newline mis-render,
            // halfway through the word). Spec §3: editOffset == null →
            // clear-all (keep returns []); else keep only spans that end
            // at or before the caret.
            clearPasteGrace(state)
            const editOffset = getCaretOffset(el)
            const kept = keepHighlightsBeforeEdit(state.items, editOffset)
            // Clear dropped items FIRST (while we still have the old
            // indices), then replace the list.
            if (kept.length < state.items.length) {
                applyScopedClearToField(state, el, kept)
            }
            state.items = kept
            return true
        }

    // Shared, rAF-coalesced scroll/resize re-anchor loop. Extracted to
    // ./reanchor.ts (Task 4b-3) as a byte-equivalent shell; the perf plan
    // rewrites the per-field body in-place. We stitch the orchestrator's
    // `item` references back into the reanchor's itemRects patch via
    // setFieldState (reanchor never sees the items).
    const reanchor = mountReanchor({
        getTrackedFields: () => runtime.trackedFields,
        getFieldState: (el) => {
            const st = runtime.fields.get(el)
            if (!st) return undefined
            return {
                items: st.items,
                useNativeHighlight: st.useNativeHighlight,
                highlightLayer: st.highlightLayer,
                hoverItemIndex: st.hoverItemIndex,
                statusHandle: st.statusHandle
                    ? { reposition: (r) => st.statusHandle!.reposition(r) }
                    : null,
            }
        },
        setFieldState: (el, patch) => {
            const st = runtime.fields.get(el)
            if (!st) return
            st.itemRects = st.items.map((it, i) => ({
                item: it,
                rects: patch.itemRects[i]?.rects ?? [],
            }))
        },
    })
    runtime.cleanups.push(reanchor.stop)

    const attach = (el: HTMLElement): void => {
        if (runtime.fields.has(el)) return
        const s = getSettings()
        const rerun = rerunFor(el)
        const attachment = createFieldAttachment(
            el,
            {
                realtimeDelayMs: s.realtimeDelayMs,
                onRunCheck: (target, text) => {
                    // The attachment's debounced callback captured `el` at
                    // attach time, so `target` will always equal `el` here.
                    // We forward to the runCheck orchestrator with the LIVE
                    // text read inside the debounce window.
                    void rerun(text)
                },
                onBlur: () => {
                    // Flush pending signals on blur; the field is leaving focus.
                    void signalQueue.flush()
                },
                // The single authoritative input gate (realtime / paste-skip /
                // paste-grace). The attachment consults this before scheduling
                // any debounced check; there is no separate capture-phase
                // listener anymore (which previously double-scheduled and
                // silently defeated paste-skip / ondemand).
                onInputEvent: onInputEventFor(el),
            },
            () => runtime.fieldCount,
            () => {
                runtime.fieldCount -= 1
            },
        )
        const state: FieldState = {
            attachment,
            items: [],
            itemRects: [],
            // Process-monotonic: a re-attached field's first seq is strictly
            // greater than any seq a torn-down field ever produced. Kills
            // the "detached field's pending check aliases a re-attached
            // field's seq" race (Spec §4 sibling). See @/lib/check-seq.
            checkSeq: nextCheckSeq(),
            pasteGraceTimer: null,
            highlightLayer: null,
            hoverItemIndex: null,
            useNativeHighlight:
                isNativeHighlightSupported() &&
                !(el instanceof HTMLTextAreaElement) &&
                !(el instanceof HTMLInputElement),
            statusHandle: null,
            restoreSpellcheck: () => {},
            lastApplied: null,
            // W3-2: seed the per-field goals from the current settings.
            // Updated when the user edits goals via the panel; the new
            // value is persisted AND pushed to settings.goals so the
            // other field's goals (and the popup) stay in sync.
            goals: s.goals,
            // W3-1: every new field starts in the 'done' phase — the
            // first render (after attach) is the post-LLM steady state.
            // The 'fast' phase is set per-frame by renderStage().
            phase: 'done',
        }
        runtime.fields.set(el, state)
        runtime.fieldCount += 1
        debugLog('field', 'attach', {
            tag: el.tagName,
            native: state.useNativeHighlight,
            total: runtime.fieldCount,
        })

        // Native-spellcheck suppression (opt-in). Record the field's ORIGINAL
        // `spellcheck` attribute so detach can restore it exactly (null when it
        // was absent), then set it to "false" when the setting is on. We never
        // clobber a page-set value permanently — the restore runs on detach AND
        // on settings-driven teardown.
        const originalSpellcheck = el.getAttribute('spellcheck')
        const restoreSpellcheck = (): void => {
            if (originalSpellcheck === null) el.removeAttribute('spellcheck')
            else el.setAttribute('spellcheck', originalSpellcheck)
        }
        state.restoreSpellcheck = restoreSpellcheck
        if (s.suppressNativeSpellcheck) el.setAttribute('spellcheck', 'false')
        runtime.cleanups.push(restoreSpellcheck)

        // Release this field's paste-grace timer on a settings-driven teardown.
        // teardownRuntime() iterates runtime.cleanups but does NOT walk the
        // fields WeakMap, so without this a pending grace timer could fire a
        // check against a torn-down overlay (a bridge call + a render into a
        // detached shadow root). The field-removal path clears it in detach().
        runtime.cleanups.push(() => {
            const st = runtime.fields.get(el)
            if (st) clearPasteGrace(st)
        })

        // Native `paste` fallback. Rich editors (Discord/Lexical, Slack, Google
        // Docs) intercept the paste ClipboardEvent and insert content via their
        // OWN reconciler, which fires NO `input` event with
        // inputType='insertFromPaste' — so the input gate above never sees the
        // paste. Listen to the native event directly (CAPTURE phase so we see it
        // even if the editor stops propagation; we never preventDefault, so the
        // editor is unaffected) and arm the same grace window. For plain fields
        // the input gate ALSO fires — arming is idempotent (re-arm just resets
        // the timer; the bridge dedupes identical text).
        const onFieldPaste = (): void => {
            const s = getSettings()
            if (s.checkMode !== 'realtime') return
            if (!s.checkPastedText) return
            const st = runtime.fields.get(el)
            if (!st) return
            armPasteGrace(el, st)
        }
        el.addEventListener('paste', onFieldPaste, { capture: true })
        runtime.cleanups.push(() =>
            el.removeEventListener('paste', onFieldPaste, { capture: true }),
        )

        // Undo/redo fallback (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z). Same problem: rich
        // editors apply undo/redo programmatically and fire no historyUndo/redo
        // `input` event. Detect the chord (capture phase, never preventing
        // default) and schedule a debounced check — the debounce window lets the
        // editor reconcile before the text is read at fire time, and coalesces
        // key-repeat. An explicit undo/redo also ends any pending paste grace.
        const onFieldUndoRedo = (e: KeyboardEvent): void => {
            const s = getSettings()
            if (s.checkMode !== 'realtime') return
            if (!isUndoRedoKeydown(e)) return
            const st = runtime.fields.get(el)
            if (!st) return
            clearPasteGrace(st)
            st.attachment.debouncedRun()
        }
        el.addEventListener('keydown', onFieldUndoRedo, { capture: true })
        runtime.cleanups.push(() =>
            el.removeEventListener('keydown', onFieldUndoRedo, { capture: true }),
        )

        // Focus/blur → drive the highlight intensity for this field. For
        // native-highlight fields, swap which bucket (idle vs `-strong`)
        // the field's ranges live in; for overlay fields, flip the
        // existing `.is-on` class via setState. Uses simple
        // bubbling listeners; capture isn't needed since no other listener
        // preventDefault's these.
        const onFieldFocus = (): void => {
            // FOCUS-ONLY pill: reveal this field's pill on focus.
            state.statusHandle?.setVisible(true)
            if (state.useNativeHighlight) {
                getNativeHighlighter().setFocusedField(el)
                return
            }
            state.highlightLayer?.setState({
                focused: true,
                hoverItemIndex: state.hoverItemIndex,
            })
        }
        const onFieldBlur = (e: FocusEvent): void => {
            // When the user clicks a suggestion in our popover, the browser
            // fires a11y focus onto the Apply button (inside our shadow-DOM
            // overlay). The composer's blur event fires with relatedTarget
            // retargeted to the overlay host. Guard against this: if focus
            // moved INTO our own overlay, keep all highlights and the popover
            // — this is a focus STEAL we triggered, not a genuine field-exit.
            if (isWithinOverlay(e.relatedTarget)) return
            // FOCUS-ONLY pill: hide this field's pill on blur so only the
            // focused field shows its pill.
            state.statusHandle?.setVisible(false)
            if (state.useNativeHighlight) {
                // Only clear focus if WE were the focused field — the
                // native highlighter's focused state is global to the
                // document, but only one field can have focus at a time
                // anyway, so this matches reality.
                getNativeHighlighter().setFocusedField(null)
            } else {
                state.highlightLayer?.setState({
                    focused: false,
                    hoverItemIndex: state.hoverItemIndex,
                })
            }
            // Spec §4 sibling: blur → clear highlights + close popover.
            // The user is leaving the field; the display state and the
            // popover would otherwise ghost-anchor over text the user
            // can no longer see in the same context. The next attach /
            // focus restarts fresh.
            if (openPopovers.has(el)) closePopoverFor(el)
            state.items = []
            state.itemRects = []
            if (state.useNativeHighlight) {
                getNativeHighlighter().setFieldHighlights(el, [])
            } else {
                state.highlightLayer?.reconcile([])
            }
        }
        el.addEventListener('focus', onFieldFocus)
        el.addEventListener('blur', onFieldBlur)
        runtime.cleanups.push(() => {
            el.removeEventListener('focus', onFieldFocus)
            el.removeEventListener('blur', onFieldBlur)
        })

        // Field-level hover/click interaction. The highlight overlay is
        // pointer-events:none, so interaction is detected on the FIELD itself
        // by hit-testing the pointer against the rendered edit rects
        // (state.itemRects). This keeps the field fully editable/selectable —
        // we never preventDefault, so a click both places the caret AND opens
        // the card. A throttled mousemove drives the hover tooltip; mouseleave
        // hides it after a grace delay (so moving onto an adjacent edit or a
        // tiny gap doesn't flicker).
        //
        // Highlight intensity (per-word hover) is updated on EVERY mousemove
        // (instant) — the throttle is applied to the chip showTooltip path
        // only, so the highlight flips without the 400ms lag.
        let lastMove = 0
        const onFieldMouseMove = (e: MouseEvent): void => {
            // Hover-index tracking runs every move (no throttle) so the
            // highlight intensity flips instantly when the pointer crosses
            // a word boundary.
            const hit = hitTest(state.itemRects, e.clientX, e.clientY)
            const nextIdx: number | null = hit ? hit.index : null
            if (nextIdx !== state.hoverItemIndex) {
                state.hoverItemIndex = nextIdx
                if (state.useNativeHighlight) {
                    getNativeHighlighter().setHoverItem(el, nextIdx)
                } else {
                    state.highlightLayer?.setState({
                        focused: document.activeElement === el,
                        hoverItemIndex: nextIdx,
                    })
                }
            }
            const now = Date.now()
            if (now - lastMove < HOVER_THROTTLE_MS) return
            lastMove = now
            // If a popover is open for this field, the chip must not reopen —
            // the popover is the single actionable surface while active.
            if (openPopovers.get(el)?.isOpen()) return
            if (!hit) {
                if (runtime.hoverItem) scheduleTooltipHide()
                return
            }
            // Already previewing this exact edit: keep it open.
            if (runtime.hoverItem === hit.item && runtime.tooltip?.isOpen()) {
                clearTooltipHide()
                return
            }
            clearTooltipHide()
            runtime.hoverItem = hit.item
            runtime.hoverField = el
            runtime.tooltip?.hide()
            runtime.tooltip = showTooltip(overlay.root, {
                anchorRect: hit.rect,
                category: hit.item.category,
                diffOriginal: hit.item.diffOriginal,
                diffCorrected: hit.item.diffCorrected,
                diffIsDeletion: hit.item.diffIsDeletion,
            })
            // Associate the chip with the field for screen readers. The hide
            // paths only clear this if the value is still exactly 'gf-chip'
            // (don't clobber a page-owned aria-describedby).
            el.setAttribute('aria-describedby', 'gf-chip')
        }
        const onFieldMouseLeave = (): void => {
            if (state.hoverItemIndex !== null) {
                state.hoverItemIndex = null
                if (state.useNativeHighlight) {
                    getNativeHighlighter().setHoverItem(el, null)
                } else {
                    state.highlightLayer?.setState({
                        focused: document.activeElement === el,
                        hoverItemIndex: null,
                    })
                }
            }
            scheduleTooltipHide()
        }
        const onFieldClick = (e: MouseEvent): void => {
            const hit = hitTest(state.itemRects, e.clientX, e.clientY)
            if (!hit) return
            hideTooltipNow()
            openPopoverFor(el, hit.item, hit.rect)
        }
        // W3-1: dblclick on a NON-flagged word → open the Synonyms
        // popover. The native browser dblclick selects the clicked word
        // (range across the word's boundaries) — we use Selection.toString
        // via the synonyms' resolveWordFromDblClick helper to map the
        // click into a code-unit span into the field's flat text. If
        // the click hits a flagged word (inside an item rect), the
        // popover opens instead — single-click on flagged words already
        // opens it, but a dblclick would otherwise feel dead. We
        // distinguish by hit-testing the itemRects first.
        const onFieldDblClick = (e: MouseEvent): void => {
            // If the dblclick hit a flagged word, let the click handler
            // chain handle the card (it'll already have opened one
            // popover, so we don't fight it).
            const flagged = hitTest(state.itemRects, e.clientX, e.clientY)
            if (flagged) return
            // Resolve the clicked word.
            const text = getText(el)
            const resolved = resolveWordFromDblClick(e, text, el)
            if (!resolved) return
            // Don't open synonyms on a word the popover would have
            // flagged (defensive — the flagged check above should catch
            // this, but a hit-test between the rects and the word
            // boundary is racy).
            const wordInsideItem = state.itemRects.some(({ rects }) =>
                rects.some(
                    (r) =>
                        r.left <= e.clientX &&
                        r.right >= e.clientX &&
                        r.top <= e.clientY &&
                        r.bottom >= e.clientY,
                ),
            )
            if (wordInsideItem) return
            // Get a word rect by measuring the span via getSpanRectsBatch
            // (mirror of how the orchestrator's hit-test rects are built).
            // MEASURE FIRST (the W3 gotcha): we capture the word's rect
            // BEFORE mounting showSynonyms. The synonyms popover's
            // anchorRect is caller-measured; a detached node's rect is
            // all zeros and the popover would fly off-screen.
            const wordRects = getSpanRectsBatch(el, [
                { start: resolved.start, end: resolved.end },
            ])
            const anchorRect = wordRects[0]?.[0] ?? el.getBoundingClientRect()
            // Dismiss any prior synonyms popover (one at a time).
            runtime.synonymsHandle?.destroy()
            // Show the popover in the LOADING state immediately (per
            // spec: "loading state shows a small spinner + Finding
            // synonyms…"; the synonyms surface itself handles the
            // empty / loaded states). Then fire the bridge call and
            // re-mount with the result.
            runtime.synonymsHandle = showSynonyms(overlay.root, {
                anchorRect,
                word: resolved.word,
                synonyms: [],
                loading: true,
                onPick: () => {
                    /* replaced on the loaded re-mount */
                },
                onClose: () => {
                    runtime.synonymsHandle = null
                },
            })
            void runtime.client
                .synonyms(resolved.word)
                .then((res) => {
                    if (!ctx.isValid) return
                    // The popover may have been closed (Escape, focus
                    // loss) while the bridge call was in flight; bail
                    // in that case.
                    if (runtime.synonymsHandle == null) return
                    // Re-measure the word's rect on the live DOM (the
                    // popover mount above detached nothing but the
                    // field could have scrolled). Bail if the rect is
                    // degenerate.
                    const liveRects = getSpanRectsBatch(el, [
                        { start: resolved.start, end: resolved.end },
                    ])
                    const liveAnchor = liveRects[0]?.[0] ?? anchorRect
                    runtime.synonymsHandle.destroy()
                    runtime.synonymsHandle = showSynonyms(overlay.root, {
                        anchorRect: liveAnchor,
                        word: resolved.word,
                        synonyms: res.synonyms,
                        loading: false,
                        onPick: (synonym: string) => {
                            // In-place swap at the resolved span. We
                            // measure the field's text inside the
                            // apply closure to stale-guard.
                            void applyEdit(
                                el,
                                { start: resolved.start, end: resolved.end },
                                synonym,
                            ).then(() => {
                                const stInner = runtime.fields.get(el)
                                if (stInner) {
                                    stInner.lastApplied = appendInverseEdit([], {
                                        start: resolved.start,
                                        end: resolved.end,
                                        replacement: synonym,
                                        original: text.slice(
                                            resolved.start,
                                            resolved.end,
                                        ),
                                    })
                                }
                                showToast(overlay.root, {
                                    message: `Replaced with "${synonym}"`,
                                    subText: 'Press Undo to revert',
                                    actionLabel: 'Undo',
                                    onUndo: () => void undoFor(el),
                                })
                                // No accepted signal — synonyms aren't
                                // bridge-tracked corrections.
                                void rerunFor(el)(getText(el))
                            })
                        },
                        onClose: () => {
                            runtime.synonymsHandle = null
                        },
                    })
                })
                .catch((e) => {
                    debugWarn('synonyms', 'fetch failed', e)
                    runtime.synonymsHandle?.destroy()
                    runtime.synonymsHandle = null
                })
        }
        el.addEventListener('mousemove', onFieldMouseMove)
        el.addEventListener('mouseleave', onFieldMouseLeave)
        el.addEventListener('click', onFieldClick)
        el.addEventListener('dblclick', onFieldDblClick)
        runtime.cleanups.push(() => {
            el.removeEventListener('mousemove', onFieldMouseMove)
            el.removeEventListener('mouseleave', onFieldMouseLeave)
            el.removeEventListener('click', onFieldClick)
            el.removeEventListener('dblclick', onFieldDblClick)
        })

        // Re-measure rects + reconcile highlights + re-anchor the pill when the
        // field's box resizes or the page scrolls (so highlights/hit-test rects
        // track the text and the pill tracks the field instead of drifting from
        // render-time viewport coords). The shared document-scroll +
        // window-resize listeners are installed ONCE in wireRuntime, not per
        // field — this field only observes ITSELF via the ResizeObserver, which
        // routes through the same coalesced loop.
        //
        // ALL fields (native + overlay) are tracked: overlay fields re-measure
        // their highlight rects, native fields re-measure their hit-test rects
        // (the CSS Custom Highlight visuals self-track reflow, but the
        // hover/click hit-test rects would go stale on scroll), and both
        // re-anchor their status pill.
        runtime.trackedFields.add(el)
        const ro = new ResizeObserver(() => reanchor.schedule())
        ro.observe(el)
        runtime.cleanups.push(() => ro.disconnect())

        // (Re-)enable initial check: if this newly-attached field is the one
        // the user was last editing when the extension/site was turned back
        // on, check it now rather than waiting for the next edit. One-shot —
        // cleared on first match so subsequent attaches don't re-fire.
        if (pendingInitialCheck && el === pendingInitialCheck) {
            pendingInitialCheck = null
            void rerunFor(el)(getText(el))
        }
    }

    const detach = (el: HTMLElement): void => {
        const state = runtime.fields.get(el)
        if (!state) return
        debugLog('field', 'detach', { tag: el.tagName, native: state.useNativeHighlight })
        // Cancel any pending paste-grace timer first so it can't fire a check
        // against a field that's leaving the DOM.
        clearPasteGrace(state)
        state.restoreSpellcheck()
        // Destroy the per-field renderer. For overlay fields that's the
        // pooled DOM nodes inside the shared shadow root. For native fields
        // it's the document-global registry entries owned by this field.
        if (state.useNativeHighlight) {
            getNativeHighlighter().clearField(el)
        } else {
            state.highlightLayer?.destroy()
            state.highlightLayer = null
        }
        // Drop from the shared tracked set so the global scroll/resize loop
        // stops calling remeasureField on a detached field. Done for BOTH
        // field types (native + overlay are both tracked now).
        runtime.trackedFields.delete(el)
        state.statusHandle = null
        // Release the per-field listeners, debouncer, and any registered
        // overlay handles. The attachment decrements runtime.fieldCount
        // exactly once (idempotent guard inside `detach`).
        state.attachment.detach()
        runtime.fields.delete(el)
        if (runtime.active?.el === el) runtime.active = null
        // Close this field's popover if open (clears runtime.activePopoverField
        // via closePopoverFor) so a detached field can't leave a dangling
        // active-popover reference.
        if (runtime.activePopoverField === el) closePopoverFor(el)
        // Hide the chip if it was previewing this field — otherwise a chip with
        // aria-describedby pointing at a removed field lingers.
        if (runtime.hoverField === el) hideTooltipNow()
    }

    runtime.stopObserver = createFieldObserver({
        root: document.body,
        onFieldDiscovered: (el) => attach(el),
        // Chatty SPAs (Gmail/Notion/Discord) add+remove editor fields
        // constantly; without this, the per-field listeners + the
        // fieldCount counter would only ever grow. Detach releases both.
        onFieldDetached: (el) => detach(el),
    })

    // Background → content: TRIGGER_CHECK (on-demand hotkey / popup "Check now")
    // and GET_TAB_STATUS (popup on open). The latter is handled synchronously
    // (Promise resolve pattern) so the popup gets a useful reply without a
    // separate bridge call.
    const messageHandler = (
        raw: unknown,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _sender: unknown,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _sendResponse: (r: unknown) => void,
    ): true | undefined => {
        if (isMessage(raw, 'TRIGGER_CHECK')) {
            void checkFocusedField()
            return undefined
        }
        if (isMessage(raw, 'REPHRASE_SELECTION')) {
            // Trigger the rephrase flow for the currently focused field —
            // same shape as the user clicking the Rephrase button on the
            // pill. The flow's rephraseFor() uses the selection when in-el,
            // else the whole field, then the same async path.
            const el = focusedTrackedField()
            if (el) rephraseFlow.rephraseFor(el)
            return undefined
        }
        if (isMessage(raw, 'GET_TAB_STATUS')) {
            const reply = buildTabStatus(runtime)
            return Promise.resolve(reply) as unknown as true
        }
        return undefined
    }
    browser.runtime.onMessage.addListener(messageHandler)
    // Mirror the remover on runtime.cleanups so a settings-driven teardown
    // disconnects the global message listener too (otherwise re-enable would
    // double-register, and the OLD messageHandler would answer GET_TAB_STATUS
    // with the stale runtime's counts).
    runtime.cleanups.push(() => browser.runtime.onMessage.removeListener(messageHandler))

    // URL change without reinjection → tear down the overlay and flush.
    // We use plain addEventListener + a runtime-scoped remover instead of
    // ctx.addEventListener so the listener goes away on settings-driven
    // teardown too. (ctx.addEventListener returns no remover; the
    // WxtWindowEventMap overload only registers — it can't be unregistered
    // by hand.)
    const onLocationChange = (): void => {
        // SPA soft-navigations (history.pushState/replaceState) fire this WITHOUT
        // re-injecting the content script. Do NOT destroy the overlay or the
        // native highlighter here — the field observer reconciles removed/added
        // fields on the new DOM, so the overlay self-heals. (Destroying here left
        // SPA pages — Discord/WhatsApp/etc. — with NO overlay or highlights until
        // a hard reload, because nothing re-mounts them.) Just drop transient
        // anchored UI whose rects are now stale, and flush pending feedback.
        dismissPopoversIn(overlay.root)
        dismissRephraseButtonsIn(overlay.root)
        dismissRephraseCardsIn(overlay.root)
        rephraseFlow.dismissButton()
        // W3-1: SPA navigation also drops the review panel + Goals
        // popover + Stats view + Synonyms popover — their rects are
        // anchored to a now-stale field rect (the field may be in
        // the same DOM but the content has navigated; the new
        // composer is a different field).
        runtime.synonymsHandle?.destroy()
        runtime.synonymsHandle = null
        runtime.goalsHandle?.destroy()
        runtime.goalsHandle = null
        runtime.statsHandle?.destroy()
        runtime.statsHandle = null
        runtime.panelHandle?.destroy()
        runtime.panelHandle = null
        runtime.panelField = null
        runtime.panelFor = null
        runtime.active = null
        // dismissPopoversIn removes the popover DOM directly (not via
        // closePopoverFor), so clear the active-field back-reference too.
        runtime.activePopoverField = null
        if (runtime.hoverTimer) {
            clearTimeout(runtime.hoverTimer)
            runtime.hoverTimer = null
        }
        runtime.tooltip?.hide()
        runtime.tooltip = null
        runtime.hoverItem = null
        runtime.hoverField = null
        void signalQueue.flush()
    }
    window.addEventListener('wxt:locationchange', onLocationChange)
    runtime.cleanups.push(() => window.removeEventListener('wxt:locationchange', onLocationChange))

    // Resolve the monitored field the user is currently editing. focus may sit
    // on a CHILD of a contenteditable, so we match the tracked field that
    // CONTAINS the active element (not just `=== activeElement`).
    const focusedTrackedField = (): HTMLElement | null => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return null
        if (runtime.fields.has(active)) return active
        for (const el of runtime.trackedFields) {
            if (el.contains(active)) return el
        }
        return null
    }

    // ---- Rephrase selection (slow LLM path) ----
    // Extracted to ./rephrase.ts (Task 4b-1). The orchestrator passes the
    // active-field resolver as a dep; the module owns the selection
    // debouncer, the scope decision, the bridge call, and the
    // apply/stale-guard. The returned `rephraseFor` is wired to the pill's
    // onRephrase below. The module's stop() is pushed to runtime.cleanups
    // so a script-invalidation teardown releases the selectionchange
    // listener and the Rephrase button.
    const rephraseFlow = mountRephraseFlow({
        client: runtime.client,
        overlayRoot: overlay.root,
        rerun: (el, text) => void rerunFor(el)(text),
        ctxIsValid: () => ctx.isValid,
        resolveActiveSelection: () => {
            for (const tel of runtime.trackedFields) {
                const f = resolveRephraseSelectionFor(tel)
                if (f) return f
            }
            return null
        },
        applyEdit,
        // W3-2: rephrase's default tone is seeded from the FOCUSED
        // field's goals. `formal`/`informal`/`neutral` map 1:1 to
        // `formality`. The rephrase flow reads this at openRephraseFor
        // time; user tone changes inside the card still win on the
        // re-issue path.
        getGoals: () => {
            const focused = document.activeElement
            if (focused instanceof HTMLElement) {
                const st = runtime.fields.get(focused)
                if (st) return st.goals
                // Try contains() — rich editors put focus on a child.
                for (const el of runtime.trackedFields) {
                    if (el.contains(focused)) {
                        const s = runtime.fields.get(el)
                        if (s) return s.goals
                    }
                }
            }
            return null
        },
    })
    runtime.cleanups.push(rephraseFlow.stop)

    // Accept hotkey (in-content keydown, NOT browser.commands — the commands
    // API is unreliable for arbitrary chords cross-OS). Pressing the configured
    // chord applies ALL of the FOCUSED field's suggestions at once (the same
    // batched, stale-guarded path the pill's "Apply all" uses). The chord only
    // acts when the focused field actually has suggestions; otherwise the event
    // passes through so normal typing / key combos keep working.
    const onKeydown = (e: KeyboardEvent): void => {
        const s = getSettings()
        const field = focusedTrackedField()
        // Rephrase hotkey runs BEFORE the accept branch (handles Rephrase on
        // a focused tracked field, with or without active suggestions). The
        // matchers are distinct by default (Ctrl+/ vs Ctrl+.) so order is
        // documentation, not a tie-breaker — but if a user rebinds the
        // accept hotkey to Ctrl+/ the rephrase branch wins.
        if (
            handleRephraseHotkey(e, {
                hotkey: s.rephraseHotkey,
                rephraseFor: (el) => rephraseFlow.rephraseFor(el),
                field,
            })
        ) {
            return
        }
        const hasSuggestions = field != null && (runtime.fields.get(field)?.items.length ?? 0) > 0
        if (
            !shouldAcceptHotkey(e, {
                hotkey: s.acceptHotkey,
                hasActiveSuggestion: hasSuggestions,
            })
        )
            return
        if (!field) return
        e.preventDefault()
        e.stopPropagation()
        // Apply every suggestion in the focused field (batched, last-to-first,
        // each re-validated against live text — see applyAllFor).
        void applyAllFor(field)
    }
    ctx.addEventListener(document, 'keydown', onKeydown)
    // Mirror the remover on runtime.cleanups so a settings-driven teardown
    // disconnects the global keydown handler too — otherwise a disable→enable
    // cycle leaves the OLD onKeydown bound to the OLD runtime, firing a
    // duplicate accept / applying against a torn-down state.
    runtime.cleanups.push(() => document.removeEventListener('keydown', onKeydown))

    // Script-invalidation teardown is wired at the top of `start(ctx)` — it
    // calls teardownRuntime(), which iterates runtime.cleanups and runs the
    // full lifecycle release. Nothing further to register here.

    // The currently-open popover per field. Tracked on the FieldState's
    // registered handles so `closePopoverFor` (and the eventual `detach`)
    // can find it without a separate registry. (We also mirror it on
    // `runtime.active.el` for the accept hotkey.)
    const openPopovers = new WeakMap<HTMLElement, PopoverHandle>()

    function closePopoverFor(el: HTMLElement): void {
        const handle = openPopovers.get(el)
        handle?.hide()
        openPopovers.delete(el)
        if (runtime.active?.el === el) runtime.active = null
        if (runtime.activePopoverField === el) runtime.activePopoverField = null
    }

    // Wire the popover callbacks (defined inline so they close over the
    // local `runtime`).
    function openPopoverFor(el: HTMLElement, item: RenderableItem, anchorRect: DOMRect): void {
        const state = runtime.fields.get(el)
        if (!state) return
        // Single-popover invariant: a popover open on a DIFFERENT field must
        // close before this one opens (openPopovers is a WeakMap, so we track
        // the active field explicitly to find it).
        if (runtime.activePopoverField && runtime.activePopoverField !== el) {
            closePopoverFor(runtime.activePopoverField)
        }
        closePopoverFor(el)
        const handle = showPopover(overlay.root, {
            anchorRect,
            category: item.category,
            message: item.message,
            diffOriginal: item.diffOriginal,
            diffCorrected: item.diffCorrected,
            diffIsDeletion: item.diffIsDeletion,
            replacements: item.replacements,
            // The popover's `original` feeds ONLY the Add-to-dictionary action.
            // Pass the WORD-RANGE text (diffOriginal — what the popover shows
            // struck through), NOT item.original: the minimal edit span trims
            // the diff's common prefix/suffix, so e.g. a "Glorpx Mubs" ->
            // "Got my dibs" rewrite (shared "G" prefix, "s" suffix) has span
            // text "lorpx Mub" — adding THAT to the dictionary stored mangled
            // fragments (verified live).
            original: item.diffOriginal,
            onAddToDictionary:
                item.category === 'spelling' && item.diffOriginal.trim().length > 0
                    ? (word: string) => void addWordToDictionary(el, item, word)
                    : undefined,
            preview: item.preview,
            onApply: (replacementIndex: number) => {
                const live = getText(el)
                if (!isSpanStillValid(live, item)) {
                    // Stale span: don't apply, just re-run.
                    closePopoverFor(el)
                    void rerunFor(el)(live)
                    return
                }
                const replacement =
                    item.replacements[replacementIndex] ?? item.replacements[0] ?? ''
                // Close the popover BEFORE the async apply: applySlateFix
                // re-focuses the editor, and a still-open popover's
                // outside-click/teardown must not fight that focus move.
                closePopoverFor(el)
                void applyEdit(el, { start: item.cuStart, end: item.cuEnd }, replacement).then(
                    () => {
                        // Record the inverse edit (single-level slot: a new apply
                        // overwrites the prior).
                        state.lastApplied = appendInverseEdit([], {
                            start: item.cuStart,
                            end: item.cuEnd,
                            replacement,
                            original: item.original,
                        })
                        flashAppliedOverlay(el, item)
                        void signalQueue.enqueue({
                            id: item.id,
                            action: 'accepted',
                            category: item.category,
                            source: 'browser',
                        })
                        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                            el.focus()
                            const end = item.cuStart + replacement.length
                            try {
                                el.setSelectionRange(item.cuStart, end)
                            } catch {
                                // some input types (number, email) throw on setSelectionRange
                            }
                        }
                        void rerunFor(el)(getText(el))
                    },
                )
            },
            onDismiss: () => {
                // W1a review nit: the popover button says "Dismiss" (since
                // W1), so the callback is now `onDismiss` (was `onIgnore`).
                // Capture the item + its index BEFORE mutating state.items
                // so the Undo closure can restore it. The 'ignored' signal
                // is enqueued unconditionally — Undo is a CLIENT-SIDE
                // visual restore only; we do NOT send a compensating
                // signal (a future bridge `un-ignore` is out of scope, and
                // the original 'ignored' event is the source of truth for
                // the training loop).
                const idx = state.items.indexOf(item)
                if (idx >= 0) state.items.splice(idx, 1)
                // Reconcile the persistent highlight layer (the highlight for
                // this item disappears) and re-render the pill (count updates).
                renderField(el, overlay.root, state)
                updateFocusedCounts(runtime, el)
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'ignored',
                    category: item.category,
                    source: 'browser',
                })
                showToast(overlay.root, {
                    message: 'Dismissed',
                    actionLabel: 'Undo',
                    onAction: () => {
                        if (idx < 0) return
                        state.items.splice(idx, 0, item)
                        renderField(el, overlay.root, state)
                        updateFocusedCounts(runtime, el)
                    },
                })
                closePopoverFor(el)
            },
            // PopoverOptions still has `onIgnore` as REQUIRED (kept for
            // back-compat with W1 callers). The new `onDismiss` callback
            // wins in the popover's dispatch (see popover.ts: when both
            // are supplied, onDismiss is called). We pass a no-op here
            // so the W1 path stays callable if some legacy code ever
            // calls opts.onIgnore directly (it does not, in the W3
            // orchestrator — the button is wired to onDismiss).
            onIgnore: () => {},
        })
        openPopovers.set(el, handle)
        runtime.active = { el, item, replacementIndex: 0 }
        runtime.activePopoverField = el
    }

    // Overlay-only apply flourish: flash the just-applied item's highlight
    // before the re-check reconciles it away. No-op for native-highlight fields
    // (no element to flash) and when the layer/index is absent.
    function flashAppliedOverlay(el: HTMLElement, item: RenderableItem): void {
        const st = runtime.fields.get(el)
        if (!st || st.useNativeHighlight || !st.highlightLayer) return
        const idx = st.items.indexOf(item)
        if (idx >= 0) st.highlightLayer.flashApplied(idx)
    }

    // Apply an item's PRIMARY replacement (stale-guarded) + emit the accepted
    // signal. Returns false (no-op) when the span has gone stale. Does not
    // re-check — the caller batches that. Async: the Slate-aware apply
    // yields a tick between selection and insert (see rich-editor-apply.ts —
    // the sync applyFix corrupted Slate's selection state).
    async function applyItemPrimary(el: HTMLElement, item: RenderableItem): Promise<boolean> {
        if (!isSpanStillValid(getText(el), item)) return false
        const replacement = item.replacements[0] ?? ''
        await applyEdit(el, { start: item.cuStart, end: item.cuEnd }, replacement)
        // Record the inverse edit (single-level slot).
        const st = runtime.fields.get(el)
        if (st) {
            st.lastApplied = appendInverseEdit([], {
                start: item.cuStart,
                end: item.cuEnd,
                replacement,
                original: item.original,
            })
        }
        void signalQueue.enqueue({
            id: item.id,
            action: 'accepted',
            category: item.category,
            source: 'browser',
        })
        return true
    }

    // Pill panel: apply ONE correction by index, then re-check.
    function applyOneFor(el: HTMLElement, index: number): void {
        const st = runtime.fields.get(el)
        const item = st?.items[index]
        if (!item) return
        closePopoverFor(el)
        void applyItemPrimary(el, item)
        flashAppliedOverlay(el, item)
        void rerunFor(el)(getText(el))
    }

    // Add the flagged word(s) to the user dictionary: persist on the bridge,
    // log a rejected signal for the edit (the personalization negative pool's
    // first real sender), re-check (the suggestion disappears server-side —
    // the bridge suppresses any edit whose span tokens are ALL allowlisted),
    // and offer Undo. The LLM can merge two adjacent unknown words into ONE
    // edit, so a multi-token original is split and each token added (the
    // dictionary stores single words). Bridge-unreachable failures surface
    // via debugWarn only.
    async function addWordToDictionary(
        el: HTMLElement,
        item: RenderableItem,
        word: string,
    ): Promise<void> {
        const tokens = [...new Set(word.split(/\s+/).filter((t) => t.length > 0))]
        if (tokens.length === 0) return
        try {
            await Promise.all(tokens.map((t) => runtime.client.dictionaryAdd(t)))
        } catch (e) {
            debugWarn('dictionary', 'add failed', e)
            return
        }
        void signalQueue.enqueue({
            id: item.id,
            action: 'rejected',
            category: item.category,
            source: 'browser',
        })
        void rerunFor(el)(getText(el))
        const label =
            tokens.length === 1
                ? `Added "${tokens[0]}" to dictionary`
                : `Added ${tokens.length} words to dictionary`
        showToast(overlay.root, {
            message: label,
            actionLabel: 'Undo',
            onAction: () => {
                void Promise.all(tokens.map((t) => runtime.client.dictionaryRemove(t)))
                    .then(() => rerunFor(el)(getText(el)))
                    .catch((e) => debugWarn('dictionary', 'undo remove failed', e))
            },
        })
    }

    // Pill panel: apply ALL corrections. Apply them ONE AT A TIME (the same
    // single-edit path individual Apply uses, which works), last-to-first so
    // earlier offsets stay valid — but YIELD A FRAME between edits so an async
    // editor (e.g. Lexical) reconciles before the next applyFix. A synchronous
    // loop corrupts the text (the next edit reads stale offsets); a whole-field
    // replace doesn't reconcile cleanly on Lexical either. Each item is
    // re-validated against the live text; signals deduped by correction id.
    async function applyAllFor(el: HTMLElement): Promise<void> {
        const st = runtime.fields.get(el)
        if (!st) return
        closePopoverFor(el)
        const ordered = [...st.items].sort((a, b) => b.cuStart - a.cuStart)
        const signaled = new Set<number>()
        // Single-level Undo slot: build a fresh batch during the loop and
        // commit it on success. (appendInverseEdit handles the higher-span
        // shift for the desc order, so a final batch lands ready to undo.)
        let batch: InverseEdit[] = []
        for (const item of ordered) {
            if (!ctx.isValid) return
            if (!isSpanStillValid(getText(el), item)) continue
            const replacement = item.replacements[0] ?? ''
            await applyEdit(el, { start: item.cuStart, end: item.cuEnd }, replacement)
            batch = appendInverseEdit(batch, {
                start: item.cuStart,
                end: item.cuEnd,
                replacement,
                original: item.original,
            })
            if (typeof item.id === 'number' && item.id > 0 && !signaled.has(item.id)) {
                signaled.add(item.id)
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'browser',
                })
            }
            // Let the editor reconcile so the next isSpanStillValid reads fresh
            // text and the next execCommand applies cleanly.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (batch.length > 0) st.lastApplied = batch
        if (!ctx.isValid) return
        void rerunFor(el)(getText(el))
    }

    // Undo the field's last apply action: re-apply the recorded inverse edits
    // highest-first, stale-guarded against the live text, then re-check. The
    // accept signals already sent are NOT compensated (client-side restore
    // only — mirrors the Ignore-Undo semantics).
    async function undoFor(el: HTMLElement): Promise<void> {
        const st = runtime.fields.get(el)
        if (!st?.lastApplied?.length) return
        const ops = planUndo(getText(el), st.lastApplied)
        st.lastApplied = null
        for (const op of ops) {
            if (!ctx.isValid) return
            await applyEdit(el, op.span, op.replacement)
            // Same rAF-yield as applyAllFor: rich editors (Lexical, Discord)
            // reconcile between edits; a synchronous loop would corrupt the
            // next applyFix's offsets.
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (!ctx.isValid) return
        // Refresh the pill so the Undo button flips back to disabled.
        renderField(el, overlay.root, st)
        updateFocusedCounts(runtime, el)
        void rerunFor(el)(getText(el))
    }

    // W3-1: accept every VISIBLE item whose confidence is at or above the
    // view-model high-confidence threshold (0.90). The visible filter
    // already applied informal-mutes-style + LLM-during-fast, so this is
    // a strict subset of `applyAllFor`. Reuses the same per-item apply +
    // rAF-yield + inverse-edit batching. Returns the list of items
    // applied (used by the caller to fire a single toast + Undo).
    async function applyHighConfFor(el: HTMLElement): Promise<RenderableItem[]> {
        const st = runtime.fields.get(el)
        if (!st) return []
        const visible = visibleItems(st.items, st.phase, st.goals)
        const high = highConfidenceItems(visible)
        if (high.length === 0) return []
        // Reuse the same last-to-first batched apply path as applyAllFor,
        // but restricted to the high-conf subset. We re-run the loop
        // here so the inverse-edit batch only covers the high items (a
        // subsequent Undo should not also undo a future low-conf apply
        // on the next pass — single-slot semantics).
        const ordered = [...high].sort((a, b) => b.cuStart - a.cuStart)
        let batch: InverseEdit[] = []
        for (const item of ordered) {
            if (!ctx.isValid) return batch.map((_b) => ({ id: -1 } as RenderableItem))
            if (!isSpanStillValid(getText(el), item)) continue
            const replacement = item.replacements[0] ?? ''
            await applyEdit(el, { start: item.cuStart, end: item.cuEnd }, replacement)
            batch = appendInverseEdit(batch, {
                start: item.cuStart,
                end: item.cuEnd,
                replacement,
                original: item.original,
            })
            if (typeof item.id === 'number' && item.id > 0) {
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'browser',
                })
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (batch.length > 0) st.lastApplied = batch
        if (!ctx.isValid) return batch.map((_b) => ({ id: -1 } as RenderableItem))
        void rerunFor(el)(getText(el))
        return high
    }

    // W3-1: accept every VISIBLE item in a single category. Mirrors
    // `applyHighConfFor` but filters on category; same rAF-yield + batch
    // + lastApplied semantics.
    async function applyCategoryFor(
        el: HTMLElement,
        cat: Category,
    ): Promise<RenderableItem[]> {
        const st = runtime.fields.get(el)
        if (!st) return []
        const visible = visibleItems(st.items, st.phase, st.goals).filter(
            (it) => it.category === cat,
        )
        if (visible.length === 0) return []
        const ordered = [...visible].sort((a, b) => b.cuStart - a.cuStart)
        let batch: InverseEdit[] = []
        for (const item of ordered) {
            if (!ctx.isValid) return batch.map((_b) => ({ id: -1 } as RenderableItem))
            if (!isSpanStillValid(getText(el), item)) continue
            const replacement = item.replacements[0] ?? ''
            await applyEdit(el, { start: item.cuStart, end: item.cuEnd }, replacement)
            batch = appendInverseEdit(batch, {
                start: item.cuStart,
                end: item.cuEnd,
                replacement,
                original: item.original,
            })
            if (typeof item.id === 'number' && item.id > 0) {
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'browser',
                })
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (batch.length > 0) st.lastApplied = batch
        if (!ctx.isValid) return batch.map((_b) => ({ id: -1 } as RenderableItem))
        void rerunFor(el)(getText(el))
        return visible
    }

    // W3-1: show a mutation toast (Undo + dismiss) for an applied batch.
    // The accept signals were already enqueued in the apply path; the
    // toast's Undo reverts the batch via `undoFor` (which uses the
    // single-slot `lastApplied`). The toast's natural auto-dismiss
    // (after `durationMs`) does NOT enqueue another signal — the
    // already-accepted record is the source of truth.
    function showMutationToast(el: HTMLElement, message: string, count: number): void {
        showToast(overlay.root, {
            message,
            subText:
                count === 1
                    ? 'Press Undo to revert'
                    : `${String(count)} changes \u00b7 press Undo to revert`,
            actionLabel: 'Undo',
            onUndo: () => void undoFor(el),
        })
    }

    // W3-1: open (or re-anchor) the per-field review panel. One panel
    // per runtime — a new showPanel dismisses the prior via the
    // showPanel's `destroyExisting`. The orchestrator owns the
    // lifecycle: the panel handle lives on `runtime.panelHandle`, the
    // owning field on `runtime.panelFor`, so onAcceptItem / onClose /
    // a later settings change can find the live references.
    //
    // MEASURE-BEFORE-RERENDER (the W3 gotcha): the panel's anchor rect
    // is read from the live orb node (`statusHandle.reposition`'s
    // previous position) or, when the status handle is absent, the
    // field's own rect. We measure FIRST, then mount the panel — a
    // detached node's getBoundingClientRect() is all zeros and the
    // panel would fly off-screen. The orb's `reposition(rect)` was
    // called on the last scroll/resize, so its current position is
    // already fresh; we read it via the field's own rect (the orb is
    // anchored to the field's bottom-right corner) and pass that to
    // showPanel.
    function openReviewPanelFor(el: HTMLElement): void {
        const st = runtime.fields.get(el)
        if (!st) return
        // Close any prior panel (defensive — showPanel's destroyExisting
        // already does this, but the orchestrator's tracked handle can
        // become stale during a rapid Goals toggle).
        if (runtime.panelHandle) {
            runtime.panelHandle.destroy()
            runtime.panelHandle = null
        }
        const text = getText(el)
        const visible = visibleItems(st.items, st.phase, st.goals)
        // Measure the field LIVE at open time. Never accept a captured
        // rect from across an async boundary (e.g. onAcceptItem
        // re-opening after applyItemPrimary + renderField reflowed the
        // field) — a detached/stale rect lands the panel off-screen.
        const anchor = el.getBoundingClientRect()
        const options: PanelOptions = {
            anchorRect: anchor,
            items: st.items,
            text,
            goals: st.goals,
            phase: st.phase,
            // W3-3b follow-up: when the site is paused (pausedCleanups is
            // the single source the active runtime's orb AND the paused
            // pill both check — see reconcile() + mountPausedModeLocal),
            // the panel renders the paused empty-state with a "Turn on
            // for this site" button. The button routes through
            // onDisableSite → togglePower → setSettings(blockedSites),
            // and the settings watcher reconciles by swapping the
            // paused pill for the active runtime. Read via the `isPaused`
            // getter wireRuntime received from start() so the two
            // surfaces never disagree. Orb-power state and
            // panel-disabled state always agree.
            disabled: isPaused(),
            onAcceptAll: () => {
                void applyAllFor(el).then(() => {
                    showMutationToast(el, 'Accepted all suggestions', visible.length)
                })
            },
            onAcceptHighConf: () => {
                void applyHighConfFor(el).then((applied) => {
                    if (applied.length > 0) {
                        showMutationToast(
                            el,
                            `Accepted ${String(applied.length)} high-confidence`,
                            applied.length,
                        )
                    }
                })
            },
            onAcceptCategory: (cat) => {
                void applyCategoryFor(el, cat).then((applied) => {
                    if (applied.length > 0) {
                        showMutationToast(
                            el,
                            `Accepted ${String(applied.length)} ${cat}`,
                            applied.length,
                        )
                    }
                })
            },
            onAcceptItem: (item) => {
                // Per-item accept from the panel: same as the popover
                // Apply (applyItemPrimary), then show a toast. The
                // panel is closed (closePopoverFor is a no-op when
                // nothing is open) so the user can re-click another row.
                void applyItemPrimary(el, item).then((applied) => {
                    if (applied) {
                        showMutationToast(el, 'Applied suggestion', 1)
                        // Re-render the panel with the fresh state so
                        // the just-applied row disappears. The panel
                        // re-opens anchored to the same field.
                        const newSt = runtime.fields.get(el)
                        if (newSt) {
                            renderField(el, overlay.root, newSt)
                            updateFocusedCounts(runtime, el)
                            // Re-anchor: destroy + re-open keeps the
                            // model in sync (a future patch can add
                            // an in-place update method).
                            if (runtime.panelHandle) {
                                runtime.panelHandle.destroy()
                                runtime.panelHandle = null
                                openReviewPanelFor(el)
                            }
                        }
                    }
                })
            },
            onRephrase: () => rephraseFlow.rephraseFor(el),
            onOpenGoals: () => {
                // Anchor the Goals popover to the panel's Goals pill —
                // its viewport rect inside the panel. We measure via
                // `getElementsByClassName` (the panel owns the .gf-
                // goals-pill element); the orchestrator measures FIRST
                // and passes the rect to showGoals, which never self-
                // measures.
                const pill = runtime.panelHandle
                    ?.getBodyContainer()
                    ?.parentElement?.querySelector<HTMLElement>('.gf-goals-pill') ??
                    null
                if (!pill) return
                const rect = pill.getBoundingClientRect()
                // Replace any prior goals popover (one at a time).
                runtime.goalsHandle?.destroy()
                runtime.goalsHandle = showGoals(overlay.root, {
                    anchorRect: rect,
                    goals: st.goals,
                    onChange: (next) => {
                        // Persist + push to every field. The settings
                        // watcher re-renders + re-opens the panel with
                        // the new goals; here we just persist (the
                        // watcher does NOT echo another showPanel for
                        // an open one because the watcher's refresh
                        // path uses the runtime.panelHandle to destroy
                        // + re-open with the new goals).
                        void setSettings({ goals: next }).catch((e) =>
                            debugWarn('goals', 'persist failed', e),
                        )
                        // Apply locally so the popover re-segments
                        // immediately; the watcher will reconcile
                        // every field in the next tick.
                        st.goals = next
                    },
                    onClose: () => {
                        runtime.goalsHandle = null
                    },
                })
            },
            onOpenStats: () => {
                // Stats mounts INTO the panel's body container (replacing
                // the review content). The destroy is handled by the
                // Stats view's own destroy; mounting a new one via
                // mountStatsView dismisses the prior (its destroyExisting
                // runs first).
                if (runtime.statsHandle) {
                    runtime.statsHandle.destroy()
                    runtime.statsHandle = null
                }
                const body = runtime.panelHandle?.getBodyContainer() ?? null
                if (!body) return
                runtime.statsHandle = mountStatsView(body, {
                    loadStats: () => runtime.client.stats(),
                    loadDict: async () => {
                        const r = await runtime.client.dictionaryList()
                        return r.words
                    },
                    removeDictWord: (word: string) => runtime.client.dictionaryRemove(word),
                })
            },
            onRecheck: () => void rerunFor(el)(getText(el)),
            onDisableSite: togglePower,
            onClose: () => {
                if (runtime.statsHandle) {
                    runtime.statsHandle.destroy()
                    runtime.statsHandle = null
                }
                if (runtime.goalsHandle) {
                    runtime.goalsHandle.destroy()
                    runtime.goalsHandle = null
                }
                runtime.panelHandle?.destroy()
                runtime.panelHandle = null
                runtime.panelField = null
                runtime.panelFor = null
            },
        }
        runtime.panelHandle = showPanel(overlay.root, options)
        runtime.panelField = el
        runtime.panelFor = el
    }

    function renderField(el: HTMLElement, root: ShadowRoot, state: FieldState): void {
        // Reset the hit-test rects every render; repopulated below when there
        // are suggestions. Cleared first so the count===0 early-return leaves
        // no stale rects for the hover/click hit-test to match.
        state.itemRects = []
        const anchor = el.getBoundingClientRect()
        const count = state.items.length
        debugLog('render', 'renderField', {
            tag: el.tagName,
            native: state.useNativeHighlight,
            count,
            focused: document.activeElement === el,
        })
        // W3-1: compute score + band via the view-model helpers. The
        // visible items run through `visibleItems` (LLM items dropped
        // on 'fast', style items dropped on 'informal') so the orb's
        // center glyph + ring color match the panel's score block.
        const visible = visibleItems(state.items, state.phase, state.goals)
        const score = computeScore(visible)
        const band = scoreBand(score)
        // Build options once; reused for both initial render and update path.
        const statusOptions: StatusButtonOptions = {
            count: visible.length,
            byCategory: tallyByCategory(visible),
            anchorRect: anchor,
            disabled: false,
            corrections: visible.map((it) => ({
                category: it.category,
                diffOriginal: it.diffOriginal,
                diffCorrected: it.diffCorrected,
                diffIsDeletion: it.diffIsDeletion,
            })),
            onFocusField: () => {
                el.focus()
            },
            onTogglePower: togglePower,
            onRecheck: () => void rerunFor(el)(getText(el)),
            onApplyAll: () => void applyAllFor(el),
            onApplyOne: (i) => applyOneFor(el, i),
            onUndo: () => void undoFor(el),
            onRephrase: () => rephraseFlow.rephraseFor(el),
            undoAvailable: (state.lastApplied?.length ?? 0) > 0,
            // W3-1: drive the orb's score ring + center glyph. The
            // center 'pip' state is automatic when phase==='fast' AND
            // visible.length>0 (see view-model.orbState). Score falls
            // back to 100 (green full ring) on the FIRST render — the
            // first check resolves with a non-default score.
            score,
            band,
            phase: state.phase,
            // W3-1: orb click → open the review panel anchored at the
            // orb's live rect. The panel is a single shared instance
            // (orchestrator-scoped handle, NOT a per-field one) — a new
            // showPanel dismisses the prior via destroyExisting().
            onOpen: () => openReviewPanelFor(el),
            // Persisted (session) pill drag offset — a dragged spot survives
            // re-renders and the enabled↔disabled swap (state in start() scope),
            // and re-anchors to the field on scroll/resize (via reposition).
            dragOffset: pillPosition.dragOffset ?? undefined,
            onDragMove: (offset) => {
                pillPosition.dragOffset = offset
            },
            // FOCUS-ONLY: the pill shows only while its field is focused. Render
            // hidden when the field isn't focused; focus/blur toggle it via
            // state.statusHandle.setVisible (below). `contains` (not `===`)
            // because rich editors can put focus on a child node of `el`.
            initiallyVisible: el.contains(document.activeElement),
        }

        // Reuse existing handle if already mounted (update in place); otherwise create.
        let statusHandle: StatusButtonHandle
        if (state.statusHandle && state.statusHandle.isMounted()) {
            state.statusHandle.update(statusOptions)
            statusHandle = state.statusHandle
        } else {
            statusHandle = renderStatusButton(root, statusOptions)
        }
        // Stash the handle so the shared scroll/resize loop can reposition the
        // pill as the field moves, and focus/blur can toggle its visibility.
        state.statusHandle = statusHandle
        if (count === 0) {
            // No suggestions this round — the status pill alone is enough.
            // The pill's destroy is idempotent, so a later render with
            // non-zero items will overwrite it cleanly. For overlay fields
            // reconcile an empty spec list so any prior highlights clear
            // instead of lingering; for native fields, clear the field's
            // entries from the registry (its ranges were registered with
            // the previous render and would otherwise stay).
            if (state.useNativeHighlight) {
                getNativeHighlighter().setFieldHighlights(el, [])
            } else {
                if (state.highlightLayer) state.highlightLayer.reconcile([])
            }
            state.attachment.setHandles({
                statusDestroy: () => statusHandle.destroy(),
                highlightDestroy: () => {
                    state.highlightLayer?.destroy()
                    state.highlightLayer = null
                },
                popoverHide: () => {
                    const h = openPopovers.get(el)
                    h?.hide()
                    openPopovers.delete(el)
                },
            })
            return
        }

        // BATCHED mirror: one layout flush for ALL of this field's
        // suggestion spans. The mirror-div technique is O(n) on text
        // length and triggers a layout reflow per append+measure; doing
        // it per suggestion (k suggestions = k reflows) was the
        // dominant cost on chatty fields (Fix 3).
        //
        // Used by BOTH the overlay layer (visual) and the native renderer
        // (hover/click hit-test rects). The native renderer doesn't need
        // these to draw (the browser tracks layout natively), but the
        // orchestrator's hit-test still needs them to map a pointer
        // position to a `RenderableItem`.
        // Highlight/hit-test the WORD range (hlStart/hlEnd), not the raw edit
        // span — a zero-width insertion (e.g. "sw"->"saw" inserts one letter)
        // has no rect, so the spelling fixes never highlighted. Apply still uses
        // the minimal [cuStart,cuEnd) span.
        const spans = state.items.map((it) => ({ start: it.hlStart, end: it.hlEnd }))
        // Defensive: a rect-measurement throw must NOT abort the highlight
        // dispatch below. On a contenteditable, skipping setFieldHighlights
        // leaves the stale CSS.highlights ranges un-rebuilt — the bug where the
        // highlight "goes away forever" after an edit. Fall back to empty rects
        // (no hit-test targets this round) but still push the highlights.
        let allRects: DOMRect[][]
        try {
            allRects = getSpanRectsBatch(el, spans)
        } catch {
            // Spec §4 sibling: measurement-throw → clear itemRects + the
            // highlight layer. Better no highlight than a stale one — the
            // next remeasure (scroll/resize, or the next edit) re-populates
            // from a clean slate. Pill update below still runs (count data
            // must never depend on rect measurability).
            state.itemRects = []
            if (state.useNativeHighlight) {
                getNativeHighlighter().setFieldHighlights(el, [])
            } else {
                state.highlightLayer?.reconcile([])
            }
            allRects = [] // keep the rest of the function safe (no re-render below)
            // Fall through to pill update + attachment handle registration.
        }
        // Cache the rects for the field-level hover/click hit-test (parallel to
        // items; an item with no rects still occupies a slot but never matches).
        if (allRects.length > 0) {
            state.itemRects = state.items.map((it, i) => ({ item: it, rects: allRects[i] ?? [] }))

            if (state.useNativeHighlight) {
                // Push code-unit spans into the document-global registry. The
                // browser draws `::highlight()` for us; reflow/scroll tracking
                // is native. Any previous overlay layer (left over from a
                // renderer switch — shouldn't happen, but defensive) is
                // destroyed so we don't leave a stale shadow-root node behind.
                if (state.highlightLayer) {
                    state.highlightLayer.destroy()
                    state.highlightLayer = null
                }
                getNativeHighlighter().setFieldHighlights(
                    el,
                    // Highlight the WORD range (hlStart/hlEnd) so zero-width
                    // insertions still get a visible ::highlight() Range.
                    state.items.map((it) => ({
                        cuStart: it.hlStart,
                        cuEnd: it.hlEnd,
                        category: it.category,
                    })),
                )
                debugLog('highlight', 'native setFieldHighlights', { count: state.items.length })
            } else {
                // Flatten (item, rect) → specs and reconcile the persistent
                // overlay layer.
                const specs: HighlightSpec[] = []
                for (let i = 0; i < state.items.length; i++) {
                    const item = state.items[i]!
                    for (const rect of allRects[i] ?? []) {
                        specs.push({ rect, category: item.category, itemIndex: i })
                    }
                }
                if (!state.highlightLayer) state.highlightLayer = createHighlightLayer(root)
                state.highlightLayer.reconcile(specs)
                debugLog('highlight', 'overlay reconcile', {
                    items: state.items.length,
                    rects: specs.length,
                })
                // Push current intensity (focus + hover) onto the
                // freshly-reconciled layer; reconcile reuses nodes, so the
                // latest state must be re-applied to keep the visual
                // consistent.
                state.highlightLayer.setState({
                    focused: document.activeElement === el,
                    hoverItemIndex: state.hoverItemIndex,
                })
            }
        }

        // The status pill is still rendered fresh each time (cheap); only the
        // highlight layer persists. Register destroy hooks so a detach/teardown
        // clears both.
        state.attachment.setHandles({
            highlightDestroy: () => {
                if (state.useNativeHighlight) {
                    getNativeHighlighter().clearField(el)
                } else {
                    state.highlightLayer?.destroy()
                    state.highlightLayer = null
                }
            },
            statusDestroy: () => statusHandle.destroy(),
            popoverHide: () => {
                const h = openPopovers.get(el)
                h?.hide()
                openPopovers.delete(el)
            },
        })
    }
}

function updateFocusedCounts(runtime: Runtime, el: HTMLElement): void {
    if (document.activeElement !== el) return
    const state = runtime.fields.get(el)
    if (!state) {
        runtime.counts = {}
        return
    }
    runtime.counts = tallyByCategory(state.items)
}

function buildTabStatus(runtime: Runtime): GfMessageMap['TAB_STATUS'] {
    return {
        type: 'TAB_STATUS',
        enabled: runtime != null,
        fieldCount: runtime.fieldCount,
        hostname: location.hostname,
        counts: { ...runtime.counts },
    }
}

/**
 * Find the edit whose viewport rect contains (x, y). Returns the item plus the
 * specific rect that was hit (used to anchor the tooltip / card). Returns null
 * when the pointer is over no edit. A wrapped edit has multiple rects; the
 * first containing rect wins. Earlier items take precedence on overlap (the
 * merge step upstream already dropped overlapping spans, so this is rare).
 */
function hitTest(
    itemRects: ReadonlyArray<{ item: RenderableItem; rects: DOMRect[] }>,
    x: number,
    y: number,
): { item: RenderableItem; rect: DOMRect; index: number } | null {
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
