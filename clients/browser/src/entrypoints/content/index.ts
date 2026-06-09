// Content-script orchestrator. The SOLE wirer (spec §3): input -> api ->
// overlay -> signal, plus the accept hotkey, the on-demand TRIGGER_CHECK
// message handler, and the TAB_STATUS reply consumed by the popup. Plain TS
// + native DOM in an open shadow root (no React — MV3 startup budget).
// Every timer and listener is registered with `ctx` so teardown happens
// automatically on script invalidation.
//
// All non-trivial logic lives in the lower layers; this file is wiring. The
// pipeline (runCheck + verifyByteSpan + deriveCategory + isSpanStillValid)
// keeps the per-text transform pure and testable in @/lib/pipeline.

import { createFieldObserver } from '@/input/observer'
import { createFieldAttachment, type FieldAttachment } from '@/input/attachment'
import { shouldCheckInput } from '@/input/paste-guard'
import { applyFix, getText } from '@/input/text'
import { isSpanStillValid, runCheck, tallyByCategory, type RenderableItem } from '@/lib/pipeline'
import { isMessage, type GfMessageMap } from '@/messaging/schema'
import { createOverlayHost } from '@/overlay/shadow-host'
import { getSpanRectsBatch } from '@/overlay/rect'
import { renderUnderlines, type UnderlineHandle } from '@/overlay/underline'
import { showPopover, type PopoverHandle } from '@/overlay/popover'
import { showTooltip, type TooltipHandle } from '@/overlay/tooltip'
import { renderStatusButton } from '@/overlay/status-button'
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
import type { ContentScriptContext } from 'wxt/utils/content-script-context'
import type { Category } from '@/api/types'

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_idle',
    main(ctx) {
        void start(ctx)
    },
})

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
    /** Latest runCheck result, used to render underlines + status pill. */
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
    let currentSettings: Settings = await getSettings()
    const hostname = location.hostname
    // The extension is globally on/off via settings.enabled; per-site disable
    // ("power off on this site") lives in the blockedSites deny-list.
    const extensionOn = (s: Settings): boolean => s.enabled
    const sitePaused = (s: Settings): boolean => isSiteBlocked(s, hostname)

    // Full checking runtime (exists only when on + site not paused). When the
    // site is paused we instead show a small standalone "power" pill so the
    // user can re-enable in-page (disabledHost).
    let runtime: Runtime | null = null
    let disabledHost: ReturnType<typeof createOverlayHost> | null = null

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
        // 3. Tear down the DOM.
        r.overlay.destroy()
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
            counts: {},
            fieldCount: 0,
            tooltip: null,
            hoverTimer: null,
            hoverItem: null,
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
        wireRuntime(ctx, r, () => currentSettings, togglePower)
    }

    // Standalone collapsed "power" pill shown when the site is paused, so the
    // user can re-enable in-page. It is NOT part of the checking runtime (which
    // is torn down while paused); it lives on its own overlay host pinned to the
    // viewport's bottom-right corner.
    const mountDisabledPill = (): void => {
        if (disabledHost) return
        const host = (disabledHost = createOverlayHost())
        renderStatusButton(host.root, {
            count: 0,
            anchorRect: new DOMRect(0, 0, window.innerWidth, window.innerHeight),
            disabled: true,
            corrections: [],
            onFocusField: () => {},
            onTogglePower: () => void togglePower(),
            onApplyAll: () => {},
            onApplyOne: () => {},
        })
    }
    const unmountDisabledPill = (): void => {
        disabledHost?.destroy()
        disabledHost = null
    }

    // Reconcile the page state to the current settings: globally off -> nothing;
    // site paused -> re-enable pill only; otherwise -> full checking runtime.
    const reconcile = (s: Settings): void => {
        if (!extensionOn(s)) {
            teardownRuntime()
            unmountDisabledPill()
            return
        }
        if (sitePaused(s)) {
            teardownRuntime()
            mountDisabledPill()
            return
        }
        unmountDisabledPill()
        initRuntime(s)
    }

    // Settings watcher — rebind the bridge client when the URL/remote opt-in
    // changes, then reconcile the runtime/pill to the new settings. Per-check
    // flags (checkPastedText, picky, checkMode) are read live from the closure.
    const unwatchSettings = settingsItem.watch((next) => {
        const prev = currentSettings
        currentSettings = next
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
        unmountDisabledPill()
    })
}

function wireRuntime(
    ctx: ContentScriptContext,
    runtime: Runtime,
    getSettings: () => Settings,
    togglePower: () => void,
): void {
    const { overlay, signalQueue } = runtime

    // ---- Hover-tooltip lifecycle (shared across fields; one tooltip at a
    // time). The tooltip itself holds no listeners/timers — the grace-delay
    // hide timer lives here on the runtime so teardown can cancel it.
    const HOVER_THROTTLE_MS = 50
    const TOOLTIP_HIDE_GRACE_MS = 150

    const clearTooltipHide = (): void => {
        if (runtime.hoverTimer) {
            clearTimeout(runtime.hoverTimer)
            runtime.hoverTimer = null
        }
    }
    const hideTooltipNow = (): void => {
        clearTooltipHide()
        runtime.tooltip?.hide()
        runtime.tooltip = null
        runtime.hoverItem = null
    }
    const scheduleTooltipHide = (): void => {
        clearTooltipHide()
        runtime.hoverTimer = setTimeout(() => {
            runtime.hoverTimer = null
            runtime.tooltip?.hide()
            runtime.tooltip = null
            runtime.hoverItem = null
        }, TOOLTIP_HIDE_GRACE_MS)
    }

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const state = runtime.fields.get(el)
            if (!state) return
            if (!ctx.isValid) return
            if (!el.isConnected) {
                // Field left the DOM mid-check: clear its overlay + hit-test
                // rects. setHandles({}) now tears down the prior render (the
                // attachment destroys the old handles on replace), so the
                // underlines don't linger after the field is gone.
                state.items = []
                state.itemRects = []
                state.attachment.setHandles({})
                updateFocusedCounts(runtime, el)
                return
            }
            // NOTE: we deliberately do NOT clear the overlay here. The prior
            // render's underlines stay visible during the (async) bridge call
            // and are swapped out atomically when renderField calls
            // setHandles(new) — which destroys the previous set. Clearing here
            // instead would blink the underlines off for the whole round-trip.
            const seq = ++state.checkSeq
            try {
                const s = getSettings()
                const { items } = await runCheck(text, {
                    correct: (t) =>
                        runtime.client.correct({ text: t, picky: s.picky, source: 'browser' }),
                })
                if (!ctx.isValid) return
                // Drop a stale result: a newer check superseded this one while
                // its request was in flight (e.g. apply → direct re-check +
                // debounced re-check race). Only the latest check renders.
                if (seq !== state.checkSeq) return
                state.items = items
                renderField(el, overlay.root, state)
                updateFocusedCounts(runtime, el)
            } catch (e) {
                // The bridge is unreachable or rejected the URL. Surface nothing
                // intrusive — the popover/pill stays in its prior state. A noisy
                // console.warn is the only signal; the popup status mirrors this.
                // oxlint-disable-next-line no-console
                console.warn('grammarforge: correct() failed', e)
            }
        }

    const checkFocusedField = async (): Promise<void> => {
        const el = document.activeElement
        if (!(el instanceof HTMLElement)) return
        const state = runtime.fields.get(el)
        if (!state) return
        await rerunFor(el)(getText(el))
    }

    const onInput =
        (el: HTMLElement) =>
        (e: Event): void => {
            // The `input` event carries an `InputEvent` with `inputType`. Gate
            // on it so a paste with checkPastedText=false never schedules a
            // check, while typing and undo/redo still do. The check itself
            // reads the field's text at FIRE time inside the debouncer, NOT
            // here — so a typing burst doesn't pay for an O(textLen) text
            // read on every keystroke (Fix 2).
            const s = getSettings()
            if (s.checkMode !== 'realtime') return
            const inputType = (e as InputEvent).inputType ?? ''
            if (!shouldCheckInput(inputType, { checkPastedText: s.checkPastedText })) return
            const state = runtime.fields.get(el)
            if (!state) return
            state.attachment.debouncedRun()
        }

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
            },
            () => runtime.fieldCount,
            () => {
                runtime.fieldCount -= 1
            },
        )
        // Bind the per-field input gating (paste policy / realtime gate)
        // on TOP of the attachment's debouncer. The attachment's input
        // listener calls debouncedRun directly, but we need to apply the
        // realtime + paste guard first. The cleanest way is to override
        // the input handler: re-add a typed one and have it call into
        // the attachment's debouncedRun.
        // (The attachment already added a plain input listener — we
        // replace it via a one-shot re-binding: removeEventListener on
        // the attachment's closure-bound handler isn't possible from
        // here, so instead we install a CAPTURING listener that runs
        // FIRST and stops propagation when the gate says "skip". The
        // attachment's handler still runs, but only with valid input
        // events reaching it. This is the simplest robust layering that
        // doesn't require the attachment to know about the gate.)
        // -> See "gating capture" below.
        const state: FieldState = {
            attachment,
            items: [],
            itemRects: [],
            checkSeq: 0,
        }
        runtime.fields.set(el, state)
        runtime.fieldCount += 1

        // Gating capture: installed at the capture phase so it sees the
        // event BEFORE the attachment's bubble-phase handler. When the
        // realtime/paste gate says "skip", we stopImmediatePropagation so
        // the attachment's listener never fires for this event. When the
        // gate says "check", we do nothing — the attachment's listener
        // runs normally and schedules the debounced run.
        const gateHandler = onInput(el)
        el.addEventListener('input', gateHandler, { capture: true })
        runtime.cleanups.push(() => el.removeEventListener('input', gateHandler, { capture: true }))

        // Field-level hover/click interaction. The underline overlay is
        // pointer-events:none, so interaction is detected on the FIELD itself
        // by hit-testing the pointer against the rendered edit rects
        // (state.itemRects). This keeps the field fully editable/selectable —
        // we never preventDefault, so a click both places the caret AND opens
        // the card. A throttled mousemove drives the hover tooltip; mouseleave
        // hides it after a grace delay (so moving onto an adjacent edit or a
        // tiny gap doesn't flicker).
        let lastMove = 0
        const onFieldMouseMove = (e: MouseEvent): void => {
            const now = Date.now()
            if (now - lastMove < HOVER_THROTTLE_MS) return
            lastMove = now
            const hit = hitTest(state.itemRects, e.clientX, e.clientY)
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
            runtime.tooltip?.hide()
            runtime.tooltip = showTooltip(overlay.root, {
                anchorRect: hit.rect,
                category: hit.item.category,
                message: hit.item.message,
                diffOriginal: hit.item.diffOriginal,
                diffCorrected: hit.item.diffCorrected,
                diffIsDeletion: hit.item.diffIsDeletion,
            })
        }
        const onFieldMouseLeave = (): void => {
            scheduleTooltipHide()
        }
        const onFieldClick = (e: MouseEvent): void => {
            const hit = hitTest(state.itemRects, e.clientX, e.clientY)
            if (!hit) return
            hideTooltipNow()
            openPopoverFor(el, hit.item, hit.rect)
        }
        el.addEventListener('mousemove', onFieldMouseMove)
        el.addEventListener('mouseleave', onFieldMouseLeave)
        el.addEventListener('click', onFieldClick)
        runtime.cleanups.push(() => {
            el.removeEventListener('mousemove', onFieldMouseMove)
            el.removeEventListener('mouseleave', onFieldMouseLeave)
            el.removeEventListener('click', onFieldClick)
        })
    }

    const detach = (el: HTMLElement): void => {
        const state = runtime.fields.get(el)
        if (!state) return
        // Release the per-field listeners, debouncer, and any registered
        // overlay handles. The attachment decrements runtime.fieldCount
        // exactly once (idempotent guard inside `detach`).
        state.attachment.detach()
        runtime.fields.delete(el)
        if (runtime.active?.el === el) runtime.active = null
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
        overlay.destroy()
        void signalQueue.flush()
    }
    window.addEventListener('wxt:locationchange', onLocationChange)
    runtime.cleanups.push(() => window.removeEventListener('wxt:locationchange', onLocationChange))

    // Accept hotkey (in-content keydown, NOT browser.commands — Ctrl+. is
    // unreliable on the commands API cross-OS). The chord only fires when a
    // suggestion is active; otherwise the event passes through to the field.
    // Before applying the fix, verify the span is still valid against the
    // LIVE field text (Fix 1: stale-span guard). If the text moved on, hide
    // the popover + re-run the check instead of corrupting the field.
    const onKeydown = (e: KeyboardEvent): void => {
        const s = getSettings()
        if (
            !shouldAcceptHotkey(e, {
                hotkey: s.acceptHotkey,
                hasActiveSuggestion: runtime.active != null,
            })
        )
            return
        const a = runtime.active
        if (!a) return
        e.preventDefault()
        e.stopPropagation()
        const live = getText(a.el)
        if (!isSpanStillValid(live, a.item)) {
            // Stale span: don't apply. Tear down this popover + re-check.
            closePopoverFor(a.el)
            void rerunFor(a.el)(live)
            return
        }
        const replacement = a.item.replacements[a.replacementIndex] ?? a.item.replacements[0] ?? ''
        applyFix(a.el, { start: a.item.cuStart, end: a.item.cuEnd }, replacement)
        void signalQueue.enqueue({
            id: a.item.id,
            action: 'accepted',
            category: a.item.category,
            source: 'browser',
        })
        closePopoverFor(a.el)
        void rerunFor(a.el)(getText(a.el))
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
    }

    // Wire the popover callbacks (defined inline so they close over the
    // local `runtime`).
    function openPopoverFor(el: HTMLElement, item: RenderableItem, anchorRect: DOMRect): void {
        const state = runtime.fields.get(el)
        if (!state) return
        closePopoverFor(el)
        const handle = showPopover(overlay.root, {
            anchorRect,
            category: item.category,
            message: item.message,
            diffOriginal: item.diffOriginal,
            diffCorrected: item.diffCorrected,
            diffIsDeletion: item.diffIsDeletion,
            replacements: item.replacements,
            original: item.original,
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
                applyFix(el, { start: item.cuStart, end: item.cuEnd }, replacement)
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'accepted',
                    category: item.category,
                    source: 'browser',
                })
                closePopoverFor(el)
                void rerunFor(el)(getText(el))
            },
            onIgnore: () => {
                void signalQueue.enqueue({
                    id: item.id,
                    action: 'ignored',
                    category: item.category,
                    source: 'browser',
                })
                closePopoverFor(el)
            },
        })
        openPopovers.set(el, handle)
        runtime.active = { el, item, replacementIndex: 0 }
    }

    // Apply an item's PRIMARY replacement (stale-guarded) + emit the accepted
    // signal. Returns false (no-op) when the span has gone stale. Does not
    // re-check — the caller batches that.
    function applyItemPrimary(el: HTMLElement, item: RenderableItem): boolean {
        if (!isSpanStillValid(getText(el), item)) return false
        applyFix(el, { start: item.cuStart, end: item.cuEnd }, item.replacements[0] ?? '')
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
        applyItemPrimary(el, item)
        void rerunFor(el)(getText(el))
    }

    // Pill panel: apply ALL corrections. We must NOT run a sync loop of
    // applyFix/execCommand on a contenteditable — the editor (e.g. Lexical)
    // reconciles asynchronously, so the 2nd edit reads stale offsets and
    // corrupts the text. Instead build the fully-corrected text as a STRING
    // (apply every still-valid edit last-to-first so earlier offsets stay
    // valid) and write it in ONE applyFix over the whole field — a single
    // execCommand, no race. Signals are deduped by correction id (all
    // suggestions of one /correct share the same logged id).
    function applyAllFor(el: HTMLElement): void {
        const st = runtime.fields.get(el)
        if (!st) return
        closePopoverFor(el)
        const original = getText(el)
        const valid = st.items.filter((it) => isSpanStillValid(original, it))
        let text = original
        for (const item of [...valid].sort((a, b) => b.cuStart - a.cuStart)) {
            text =
                text.slice(0, item.cuStart) + (item.replacements[0] ?? '') + text.slice(item.cuEnd)
        }
        if (text !== original) {
            applyFix(el, { start: 0, end: original.length }, text)
            const signaled = new Set<number>()
            for (const item of valid) {
                if (typeof item.id === 'number' && item.id > 0 && !signaled.has(item.id)) {
                    signaled.add(item.id)
                    void signalQueue.enqueue({
                        id: item.id,
                        action: 'accepted',
                        category: item.category,
                        source: 'browser',
                    })
                }
            }
        }
        void rerunFor(el)(getText(el))
    }

    function renderField(el: HTMLElement, root: ShadowRoot, state: FieldState): void {
        // Reset the hit-test rects every render; repopulated below when there
        // are suggestions. Cleared first so the count===0 early-return leaves
        // no stale rects for the hover/click hit-test to match.
        state.itemRects = []
        const anchor = el.getBoundingClientRect()
        const count = state.items.length
        const statusHandle = renderStatusButton(root, {
            count,
            byCategory: tallyByCategory(state.items),
            anchorRect: anchor,
            disabled: false,
            corrections: state.items.map((it) => ({
                category: it.category,
                diffOriginal: it.diffOriginal,
                diffCorrected: it.diffCorrected,
                diffIsDeletion: it.diffIsDeletion,
            })),
            onFocusField: () => {
                el.focus()
            },
            onTogglePower: togglePower,
            onApplyAll: () => applyAllFor(el),
            onApplyOne: (i) => applyOneFor(el, i),
        })
        if (count === 0) {
            // No suggestions this round — the status pill alone is enough.
            // The pill's destroy is idempotent, so a later render with
            // non-zero items will overwrite it cleanly.
            state.attachment.setHandles({
                statusDestroy: () => statusHandle.destroy(),
            })
            return
        }

        // BATCHED mirror: one layout flush for ALL of this field's
        // suggestion spans. The mirror-div technique is O(n) on text
        // length and triggers a layout reflow per append+measure; doing
        // it per suggestion (k suggestions = k reflows) was the
        // dominant cost on chatty fields (Fix 3).
        const spans = state.items.map((it) => ({ start: it.cuStart, end: it.cuEnd }))
        const allRects = getSpanRectsBatch(el, spans)
        // Cache the rects for the field-level hover/click hit-test (parallel to
        // items; an item with no rects still occupies a slot but never matches).
        state.itemRects = state.items.map((it, i) => ({ item: it, rects: allRects[i] ?? [] }))

        const nodes: HTMLDivElement[] = []
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i]!
            const rects = allRects[i] ?? []
            if (rects.length === 0) continue
            const handle = renderUnderlines(root, {
                rects,
                category: item.category,
            })
            for (const n of handle.nodes) nodes.push(n)
        }
        const underlineHandle: UnderlineHandle = {
            nodes,
            destroy: () => {
                for (const n of nodes) n.remove()
            },
        }
        // Register the destroy hooks on the attachment so a future
        // `detach()` (SPA field removal, settings-driven teardown, the
        // next renderField) tears them down deterministically. The
        // popover handle — if one is open — is read lazily from the
        // WeakMap so we don't capture a stale reference here.
        state.attachment.setHandles({
            underlineDestroy: () => underlineHandle.destroy(),
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
): { item: RenderableItem; rect: DOMRect } | null {
    for (const entry of itemRects) {
        for (const r of entry.rects) {
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                return { item: entry.item, rect: r }
            }
        }
    }
    return null
}
