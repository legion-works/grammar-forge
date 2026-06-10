// Vencord orchestrator: the SOLE wirer for the Discord composer, composing
// the browser client's battle-tested layers (attachment/debounce, pipeline,
// overlay, popover, signal queue). Mirrors clients/browser
// entrypoints/content/index.ts but minimal-v1 scope (no status pill, no
// hover tooltip, no undo, no native CSS Custom Highlight, plain correct()).
// All teardown handles are collected so stop() restores Discord to its
// unmonitored state.
import { createFieldObserver } from '@/input/observer'
import { createFieldAttachment, type FieldAttachment } from '@/input/attachment'
import { isPasteInput, shouldCheckInput } from '@/input/paste-guard'
import { applyFix, getText } from '@/input/text'
import { buildRenderableItems, isSpanStillValid, type RenderableItem } from '@/lib/pipeline'
import { BridgeClient } from '@/api/client'
import { createSignalQueue } from '@/signal/queue'
import { createOverlayHost } from '@/overlay/shadow-host'
import { getSpanRectsBatch } from '@/overlay/rect'
import { createHighlightLayer, type HighlightLayer, type HighlightSpec } from '@/overlay/highlight'
import { showPopover, dismissPopoversIn, type PopoverHandle } from '@/overlay/popover'
import { shouldAcceptHotkey } from '@/hotkeys/accept'
import { isDiscordComposer } from './composer'
import type { GrammarForgeConfig } from './settings'

// Fixed paste-grace window for v1. After a paste/drop, the immediate check is
// suppressed for this many ms so the user can edit the pasted text before
// GrammarForge flags it.
const PASTE_GRACE_MS = 1500

export type InputDecision = 'check' | 'skip' | 'grace'

/** Pure input-event policy: typing checks; pastes skip (default) or defer
 *  to a grace window (checkPastedText on). */
export function inputGate(inputType: string, opts: { checkPastedText: boolean }): InputDecision {
    if (isPasteInput(inputType)) return opts.checkPastedText ? 'grace' : 'skip'
    return shouldCheckInput(inputType, { checkPastedText: true }) ? 'check' : 'skip'
}

interface FieldState {
    attachment: FieldAttachment
    items: RenderableItem[]
    itemRects: Array<{ item: RenderableItem; rects: DOMRect[] }>
    checkSeq: number
    pasteGraceTimer: ReturnType<typeof setTimeout> | null
    highlightLayer: HighlightLayer | null
}

export interface Orchestrator {
    stop: () => void
}

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

export function startOrchestrator(getConfig: () => GrammarForgeConfig): Orchestrator {
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

    const clearPasteGrace = (st: FieldState): void => {
        if (st.pasteGraceTimer != null) {
            clearTimeout(st.pasteGraceTimer)
            st.pasteGraceTimer = null
        }
    }

    const renderField = (el: HTMLElement, st: FieldState): void => {
        st.itemRects = []
        if (st.items.length === 0) {
            st.highlightLayer?.reconcile([])
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
    }

    const rerunFor =
        (el: HTMLElement) =>
        async (text: string): Promise<void> => {
            const st = fields.get(el)
            if (!st) return
            if (!el.isConnected) {
                st.items = []
                renderField(el, st)
                return
            }
            const seq = ++st.checkSeq
            try {
                const res = await refreshClient().correct({ text, source: 'vencord' })
                if (seq !== st.checkSeq) return
                st.items = buildRenderableItems(text, res).items
                renderField(el, st)
            } catch {
                // Bridge unreachable: silent idle, no intrusive toast in v1.
            }
        }

    const applyItem = (el: HTMLElement, item: RenderableItem): void => {
        const st = fields.get(el)
        if (!st) return
        if (!isSpanStillValid(getText(el), item)) {
            void rerunFor(el)(getText(el))
            return
        }
        const replacement = item.replacements[0] ?? ''
        applyFix(el, { start: item.cuStart, end: item.cuEnd }, replacement)
        signalQueue.enqueue({
            id: item.id,
            action: 'accepted',
            category: item.category,
            source: 'vencord',
        })
        void rerunFor(el)(getText(el))
    }

    const closePopoverFor = (el: HTMLElement): void => {
        openPopovers.get(el)?.hide()
        openPopovers.delete(el)
    }

    const openPopoverFor = (el: HTMLElement, item: RenderableItem, anchorRect: DOMRect): void => {
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

    const focusedTrackedField = (): HTMLElement | null => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return null
        if (fields.has(active)) return active
        for (const el of trackedFields) {
            if (el.contains(active)) return el
        }
        return null
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
        }
        fields.set(el, st)
        trackedFields.add(el)
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
            if (!hit) return
            openPopoverFor(el, hit.item, hit.rect)
        }
        el.addEventListener('click', onFieldClick)
        cleanups.push(() => el.removeEventListener('click', onFieldClick))

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
    }

    const stopObserver = createFieldObserver({
        root: document.body,
        onFieldDiscovered: (el) => {
            if (isDiscordComposer(el)) attach(el)
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
        if (
            !shouldAcceptHotkey(e, {
                hotkey: getConfig().acceptHotkey,
                hasActiveSuggestion: true,
            })
        ) {
            return
        }
        e.preventDefault()
        e.stopPropagation()
        const first = st.items[0]
        if (first) applyItem(field, first)
    }
    document.addEventListener('keydown', onKeydown, { capture: true })
    cleanups.push(() => document.removeEventListener('keydown', onKeydown, { capture: true }))

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
            dismissPopoversIn(overlay.root)
            overlay.destroy()
            void signalQueue.flush()
        },
    }
}
