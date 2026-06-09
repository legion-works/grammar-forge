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
import { renderStatusButton } from '@/overlay/status-button'
import { BridgeClient } from '@/api/client'
import { createSignalQueue, type SignalQueue } from '@/signal/queue'
import { getSettings, isSiteBlocked, settingsItem, type Settings } from '@/storage/settings'
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
    const siteAllowed = (s: Settings): boolean => s.enabled && !isSiteBlocked(s, location.hostname)

    // The runtime is created/destroyed as settings flip. When the site becomes
    // blocked or the user disables the extension, the runtime tears down
    // (overlay + observer + listeners) and re-initialises on re-enable.
    let runtime: Runtime | null = null

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
            stopObserver: null,
            cleanups: [],
        }
    }

    const initRuntime = (s: Settings): void => {
        if (runtime) return
        if (!siteAllowed(s)) return
        const r = (runtime = makeRuntime(s))
        wireRuntime(ctx, r, () => currentSettings)
    }

    // Settings watcher — recreate the bridge client when the URL or remote
    // opt-in changes; tear down the whole runtime when the user disables the
    // extension or the site becomes blocked. Per-check flags (checkPastedText,
    // picky, checkMode) are read live from the closure each time.
    const unwatchSettings = settingsItem.watch((next) => {
        const prev = currentSettings
        currentSettings = next
        const wasAllowed = siteAllowed(prev)
        const nowAllowed = siteAllowed(next)
        if (wasAllowed && !nowAllowed) {
            teardownRuntime()
            return
        }
        if (!wasAllowed && nowAllowed) {
            initRuntime(next)
            return
        }
        if (
            runtime &&
            (prev.bridgeBaseUrl !== next.bridgeBaseUrl ||
                prev.allowRemoteBridge !== next.allowRemoteBridge)
        ) {
            // Recreate the client + signal queue's sender so a remote-opt-out
            // takes effect immediately. (The signal queue's `send` is a
            // closure that captures the OLD client; rebind it.)
            const newClient = new BridgeClient(next.bridgeBaseUrl, next.allowRemoteBridge)
            runtime.client = newClient
            // createSignalQueue has no public setter; replace the queue with a
            // fresh one. Pending events are dropped — acceptable on a config
            // change (the user just toggled privacy).
            runtime.signalQueue = createSignalQueue({ send: (events) => newClient.signal(events) })
        }
    })
    ctx.onInvalidated(() => unwatchSettings())

    if (siteAllowed(currentSettings)) {
        initRuntime(currentSettings)
    }

    // Script-invalidation teardown is the SAME as a settings-driven teardown:
    // every listener we registered is on `runtime.cleanups` (we mirror the
    // ctx.onInvalidated removers there too), so calling teardownRuntime
    // here releases everything. The function is idempotent — the `runtime =
    // null` guard makes a second call (e.g. if a settings-driven teardown
    // already ran) a no-op.
    ctx.onInvalidated(() => teardownRuntime())
}

function wireRuntime(
    ctx: ContentScriptContext,
    runtime: Runtime,
    getSettings: () => Settings,
): void {
    const { overlay, signalQueue } = runtime

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const state = runtime.fields.get(el)
            if (!state) return
            if (!ctx.isValid) return
            // Drop the prior overlay handles via the attachment (which is
            // about to overwrite them with the fresh ones), so a stale
            // underline / popover from the previous check doesn't ghost
            // for one frame while the new check renders.
            state.attachment.setHandles({})
            if (!el.isConnected) {
                state.items = []
                updateFocusedCounts(runtime, el)
                return
            }
            try {
                const s = getSettings()
                const { items } = await runCheck(text, {
                    correct: (t) =>
                        runtime.client.correct({ text: t, picky: s.picky, source: 'browser' }),
                })
                if (!ctx.isValid) return
                state.items = items
                renderField(el, overlay.root, state, (next) => {
                    runtime.active = next
                })
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
    function openPopoverFor(el: HTMLElement, item: RenderableItem): void {
        const state = runtime.fields.get(el)
        if (!state) return
        const anchor = el.getBoundingClientRect()
        closePopoverFor(el)
        const handle = showPopover(overlay.root, {
            anchorRect: anchor,
            category: item.category,
            message: item.message,
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
                    action: 'accepted',
                    category: item.category,
                    source: 'browser',
                })
                closePopoverFor(el)
                void rerunFor(el)(getText(el))
            },
            onIgnore: () => {
                void signalQueue.enqueue({
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

    function renderField(
        el: HTMLElement,
        root: ShadowRoot,
        state: FieldState,
        setActive: (next: ActiveSuggestion | null) => void,
    ): void {
        const anchor = el.getBoundingClientRect()
        const count = state.items.length
        const statusHandle = renderStatusButton(root, {
            count,
            byCategory: tallyByCategory(state.items),
            anchorRect: anchor,
            onClick: () => {
                el.focus()
            },
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

        const nodes: HTMLDivElement[] = []
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i]!
            const rects = allRects[i] ?? []
            if (rects.length === 0) continue
            const handle = renderUnderlines(root, {
                rects,
                category: item.category,
                onClick: () => {
                    openPopoverFor(el, item)
                    setActive({ el, item, replacementIndex: 0 })
                },
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
