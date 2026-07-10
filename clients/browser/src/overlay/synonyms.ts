// The W2-5 Synonyms popover — opens on double-click of a NON-flagged
// word. Fetches a synonym list from the bridge, shows a small menu of
// alternatives, and calls onPick(synonym) when the user picks one. The
// orchestrator (W3 wiring) owns the in-place text swap + the Undo toast
// — the popover is the surface ONLY.
//
// Two exported pieces:
//   1. `resolveWordAtPoint(text, offset)` — PURE: given field text and
//      a UTF-16 code-unit offset, return the word containing that offset
//      (with whitespace + punctuation trimmed). This is the unit-testable
//      heart of the double-click detection. Edge cases covered: word at
//      start / end / with apostrophes / hyphens / only punctuation /
//      offset past end of text.
//   2. `showSynonyms(root, options)` — DOM mount. Caller passes a
//      caller-measured `anchorRect` (surface contract). The popover
//      handles loading + empty + loaded states. The synonyms list is
//      INJECTED via `loadSynonyms(word)` so the unit tests can swap a
//      fake in.
//
// Surface invariants (per the W2b spec):
//   - Caller-measured `anchorRect` — no self-measure.
//   - `opacity: 1` default + transform-only entrance.
//   - `transform-origin: 50% 100%` so the popover scales in from the
//     word it points at (tail at the top, sits below the word).
//   - Esc + outside-click dismiss; selection is the popover's parent.

/** The word a synonym will replace, with the UTF-16 code-unit range
 *  into the field text. */
export interface ResolvedWord {
    word: string
    start: number
    end: number
}

/** A predicate that decides whether a given Unicode code-point is part
 *  of a word. Defaults to letters, marks, numbers, underscore, hyphen,
 *  and the apostrophe (so "don't", "co-op", and "Vencord's" all resolve
 *  as a single word). The set is intentionally narrow — synonyms are
 *  usually a content word, not surrounding punctuation. */
export function isWordChar(ch: string): boolean {
    if (ch === '' || ch === undefined) return false
    if (ch === '_' || ch === '-' || ch === '\u2019' || ch === "'") return true
    return /[\p{L}\p{N}\p{M}]/u.test(ch)
}

/** PURE — given field text + a UTF-16 code-unit offset, return the word
 *  containing that offset (with the boundary expanded outward to
 *  include adjacent word characters). Returns null when:
 *    - the offset is out of range (< 0 or > text.length)
 *    - there is no word at the offset (only punctuation / whitespace)
 *  The returned `start` / `end` are slice indices into `text`. */
export function resolveWordAtPoint(text: string, offset: number): ResolvedWord | null {
    if (typeof text !== 'string' || typeof offset !== 'number') return null
    if (!Number.isFinite(offset) || offset < 0 || offset > text.length) return null
    // Clamp to the last code unit's BOUNDARY — the browser may report
    // an offset inside a surrogate pair or right at EOF; either way the
    // word resolver must not crash.
    if (offset === text.length) {
        // Only treat as a real word if the previous character is a word
        // character AND there's no trailing whitespace between them.
        if (offset === 0) return null
        const prev = text[offset - 1] ?? ''
        if (!isWordChar(prev)) return null
    }
    let start = offset
    let end = offset
    while (start > 0 && isWordChar(text[start - 1] ?? '')) start--
    while (end < text.length && isWordChar(text[end] ?? '')) end++
    if (start === end) return null
    const word = text.slice(start, end)
    if (word.length === 0) return null
    return { word, start, end }
}

/** DOM-side helper: given a dblclick event + a field element, return the
 *  text-offset for the click. Uses `caretPositionFromPoint` /
 *  `caretRangeFromPoint` so the offset reflects the visual caret
 *  position (text inside a `<textarea>` / `<input>` / contenteditable
 *  is handled by the browser). Returns -1 when the browser does not
 *  expose either API. */
export function offsetFromDblClick(event: MouseEvent, fieldEl: HTMLElement): number {
    // For <textarea> and <input>, caretPositionFromPoint / caretRangeFromPoint
    // return the textarea element itself (not a text node inside it), so
    // range.setStart(fieldEl, 0) → range.setEnd(textarea, 0) → length 0 →
    // offset 0 → always resolves the FIRST word. The reliable source for
    // textarea/input is selectionStart: the browser selects the double-clicked
    // word on dblclick, so selectionStart is the word's start offset.
    if (fieldEl instanceof HTMLTextAreaElement || fieldEl instanceof HTMLInputElement) {
        const sel = fieldEl.selectionStart
        return sel !== null ? sel : -1
    }
    const doc = fieldEl.ownerDocument ?? document
    const x = event.clientX
    const y = event.clientY
    const w = fieldEl.ownerDocument?.defaultView ?? window
    // Prefer the modern API (Chromium 120+, Firefox 132+).
    type CaretPosLike = { offsetNode: Node; offset: number } | null
    const caretPosition = (
        w as unknown as { caretPositionFromPoint?: (x: number, y: number) => CaretPosLike }
    ).caretPositionFromPoint
    if (typeof caretPosition === 'function') {
        try {
            const pos = caretPosition.call(doc, x, y)
            if (pos && pos.offsetNode) {
                // Compute the offset within `fieldEl` (the field's text
                // content is what `resolveWordAtPoint` indexes into).
                const range = doc.createRange()
                range.setStart(fieldEl, 0)
                range.setEnd(pos.offsetNode, pos.offset)
                return range.toString().length
            }
        } catch {
            /* fall through */
        }
    }
    type CaretRangeLike = { startContainer: Node; startOffset: number } | null
    const caretRange = (
        doc as unknown as { caretRangeFromPoint?: (x: number, y: number) => CaretRangeLike }
    ).caretRangeFromPoint
    if (typeof caretRange === 'function') {
        try {
            const r = caretRange.call(doc, x, y)
            if (r && r.startContainer) {
                const range = doc.createRange()
                range.setStart(fieldEl, 0)
                range.setEnd(r.startContainer, r.startOffset)
                return range.toString().length
            }
        } catch {
            /* fall through */
        }
    }
    return -1
}

/** High-level convenience: resolve the word under a dblclick on a field.
 *  Combines `offsetFromDblClick` + `resolveWordAtPoint`. Returns null
 *  when the browser cannot map the click to a text offset, or when the
 *  offset is not on a word. The orchestrator's dblclick handler uses
 *  this to decide whether to open the popover. */
export function resolveWordFromDblClick(
    event: MouseEvent,
    text: string,
    fieldEl: HTMLElement,
): ResolvedWord | null {
    const offset = offsetFromDblClick(event, fieldEl)
    if (offset < 0) return null
    return resolveWordAtPoint(text, offset)
}

/** A half-open code-unit range an open correction underline covers. Shape
 *  mirrors the `cuStart`/`cuEnd` fields already on `RenderableItem`
 *  (@/lib/pipeline) in both clients — callers pass their live items
 *  straight through with no reshaping. */
export interface FlaggedRange {
    cuStart: number
    cuEnd: number
}

/**
 * PURE — the "clean word" predicate shared by the double-click-to-select
 * word path (superseded — see below) and the split rephrase/synonyms
 * control's Synonyms segment gate (Feature 2b). Given the FULL field text
 * and a selection span (absolute code-unit offsets, e.g. from
 * `selectionStart`/`selectionEnd` or `Range` resolution), returns the
 * `ResolvedWord` when the selection is EXACTLY one word with no active
 * correction on it, else `null`.
 *
 * "Exactly one word" means:
 *   - the span is non-empty and every code point in it is a word character
 *     (`isWordChar`)
 *   - the character immediately before `start` (if any) and immediately at
 *     `end` (if any) are NOT word characters — the selection boundary must
 *     land on the word's natural edges, not mid-word (a selection of just
 *     "orge" inside "GrammarForge" is not a clean word) and not span past it
 *     into an adjacent word.
 *
 * "No active correction" means no entry in `flagged` overlaps `[start, end)`
 * — mirrors the dblclick handlers' pre-Feature-2 hit-test against open
 * correction items in both clients (browser: itemRects; vencord: s.items),
 * just expressed against the item's code-unit range instead of a rendered
 * rect so it works identically for a selection that never involved a mouse
 * click.
 */
export function isSingleCleanWordSelection(
    text: string,
    span: { start: number; end: number },
    flagged: ReadonlyArray<FlaggedRange>,
): ResolvedWord | null {
    const { start, end } = span
    if (
        typeof text !== 'string' ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end > text.length ||
        end <= start
    ) {
        return null
    }
    const slice = text.slice(start, end)
    for (let i = start; i < end; i++) {
        if (!isWordChar(text[i] ?? '')) return null
    }
    const before = start > 0 ? (text[start - 1] ?? '') : ''
    if (before && isWordChar(before)) return null
    const after = end < text.length ? (text[end] ?? '') : ''
    if (after && isWordChar(after)) return null
    const isFlagged = flagged.some((f) => start < f.cuEnd && end > f.cuStart)
    if (isFlagged) return null
    return { word: slice, start, end }
}

export interface SynonymsOptions {
    /** Viewport rect the popover anchors to (the word's bounding rect,
     *  caller-measured). */
    anchorRect: DOMRect
    /** The word the user double-clicked (displayed in the popover head
     *  and sent back via onPick). */
    word: string
    /** The synonym list. When the surface is in the "loading" state
     *  the caller passes an empty array (the surface shows a spinner
     *  instead). The surface itself never re-queries — the orchestrator
     *  fires the bridge call and re-mounts the popover with the result. */
    synonyms: readonly string[]
    /** True while the bridge is in flight. The surface shows a small
     *  spinner + "Finding synonyms…" line; the synonym list (if any)
     *  is hidden until loading is false. */
    loading: boolean
    /** Pick a synonym — the orchestrator does the in-place swap +
     *  Undo toast. The popover does NOT mutate any text itself. */
    onPick: (synonym: string) => void
    /** Esc / outside-click / × close — the caller calls `destroy()`. */
    onClose: () => void
    /** Optional viewport rect of the host chrome the popover must clear
     *  (e.g. Discord's composer box). When the popover flips ABOVE the
     *  anchor, it clears the TOP of this rect instead of just the word;
     *  when placed BELOW, it clears the rect's BOTTOM. The word rect
     *  alone is not enough in Discord: the word sits inside the composer,
     *  so clearing the word still overlaps the composer chrome
     *  (overlap reported live 2026-07). */
    clearRect?: DOMRect
}

export interface SynonymsHandle {
    destroy: () => void
    isOpen: () => boolean
}

const VIEWPORT_GUTTER = 8
const POPOVER_WIDTH = 190
const POPOVER_HEIGHT_FALLBACK = 140
// Gap between the popover and the anchored word. The flip-ABOVE gap is larger
// than the below gap so the popover clears the word AND any host chrome under
// it — in Discord the composer sits at the screen bottom, so the popover always
// flips above and a tight 6px gap left it flush against Discord's own composer /
// autocomplete panel (overlap reported 2026-07). Extra clearance lifts it off.
const POPOVER_GAP_BELOW = 6
const POPOVER_GAP_ABOVE = 14

/**
 * Mount the Synonyms popover in the supplied shadow root, anchored to
 * the supplied rect. Replaces any prior synonyms popover (one per
 * root). The popover sits BELOW the word (the tail points up at the
 * word's baseline) and is viewport-clamped.
 */
import {
    installEscapeCapture,
    installOutsideDismiss,
    type EscapeCaptureHandle,
    type OutsideDismissHandle,
} from '@/overlay/dismiss'
import { debugLog } from '@/lib/debug-log'

export function showSynonyms(root: ShadowRoot, options: SynonymsOptions): SynonymsHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    // P1-5: capture whatever had focus before the popover opened so every
    // close path can restore it (see popover.ts for the full rationale).
    const previouslyFocused = doc.activeElement instanceof HTMLElement ? doc.activeElement : null

    const pop = doc.createElement('div')
    pop.className = 'gf-syn'
    pop.setAttribute('role', 'menu')
    pop.setAttribute('aria-label', `Synonyms for ${options.word}`)

    // Head
    const head = el(pop, 'div', 'gf-syn__head')
    head.textContent = `\u21C4 Synonyms\u00A0\u00B7\u00A0${options.word}`

    // Body — either a loading spinner, an empty line, or the list of
    // pickable rows.
    if (options.loading) {
        const loading = el(pop, 'div', 'gf-syn__loading')
        el(loading, 'span', 'gf-syn__spinner')
        const text = el(loading, 'span')
        text.textContent = 'Finding synonyms\u2026'
    } else if (options.synonyms.length === 0) {
        const empty = el(pop, 'div', 'gf-syn__empty')
        empty.textContent = 'No synonyms found.'
    } else {
        const list = el(pop, 'div', 'gf-syn__list')
        for (const syn of options.synonyms) {
            const row = el(list, 'button', 'gf-syn__row') as HTMLButtonElement
            row.type = 'button'
            row.setAttribute('role', 'menuitem')
            row.textContent = syn
            row.addEventListener('mousedown', (e) => e.preventDefault())
            row.addEventListener('click', (e) => {
                e.preventDefault()
                e.stopPropagation()
                options.onPick(syn)
            })
        }
    }

    // Tail — the upward caret pointing at the word the user
    // double-clicked. Positioned along the bottom of the popover (the
    // popover sits BELOW the word). The transform-origin above already
    // biases the entrance to grow from the tail.
    el(pop, 'span', 'gf-syn__tail')

    root.appendChild(pop)
    positionPopover(pop, options.anchorRect, view, options.clearRect)

    // Re-position after first paint: multi-line synonym rows wrap inside
    // the fixed 190px width, so the real height can exceed the pre-paint
    // measurement. The rAF re-measure keeps the popover's BOTTOM clear of
    // the anchor/composer once the true height is known.
    const repositionFrame = view.requestAnimationFrame(() => {
        if (pop.isConnected) positionPopover(pop, options.anchorRect, view, options.clearRect)
    })

    // Esc dismiss — window capture (P1-7), same fix as the outside-click
    // dismiss below: a document-bubble listener never fires on hosts that
    // stopPropagation at window capture.
    const escapeCapture: EscapeCaptureHandle = installEscapeCapture(view, () => options.onClose(), 'synonyms')

    // Outside-click (light-dismiss) via the unified dismiss helper.
    // Uses window capture so host-page stopPropagation can't block it.
    const outsideDismiss: OutsideDismissHandle = installOutsideDismiss(
        view,
        (el) => pop.contains(el) || el === pop,
        () => options.onClose(),
        'synonyms',
    )

    const handle: SynonymsHandle = {
        destroy: () => {
            view.cancelAnimationFrame(repositionFrame)
            outsideDismiss.remove()
            escapeCapture.remove()
            if (pop.isConnected) pop.remove()
            // P1-5: restore focus to whatever had it before this popover
            // opened, on EVERY close path (destroy() is the single funnel
            // for Esc, outside-dismiss, and programmatic teardown alike).
            if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus()
            unregisterSynonyms(root, handle)
        },
        isOpen: () => pop.isConnected,
    }
    registerSynonyms(root, handle)

    return handle
}

// Per-root registry: mirror of popover.ts / rephrase-card.ts's REGISTRY
// pattern. destroyExisting() used to only querySelectorAll(...).remove()
// the prior popover's DOM, never calling its destroy() — which left the
// prior instance's installOutsideDismiss (window-capture pointerdown),
// installEscapeCapture (window-capture keydown), and pending
// repositionFrame rAF all orphaned on every re-open (one popover reopens
// on every dblclick — a chatty surface where this leak compounds fast).
const REGISTRY = new WeakMap<ShadowRoot, Set<SynonymsHandle>>()

function registerSynonyms(root: ShadowRoot, handle: SynonymsHandle): void {
    let set = REGISTRY.get(root)
    if (!set) {
        set = new Set()
        REGISTRY.set(root, set)
    }
    set.add(handle)
}

function unregisterSynonyms(root: ShadowRoot, handle: SynonymsHandle): void {
    const set = REGISTRY.get(root)
    if (!set) return
    set.delete(handle)
    if (set.size === 0) REGISTRY.delete(root)
}

/** Destroy every Synonyms popover currently mounted in `root` via the real
 *  `destroy()` (releasing its listeners + pending rAF + restoring focus),
 *  not just its DOM. Exported for the shadow host's teardown, mirroring
 *  dismissPopoversIn / dismissRephraseCardsIn. */
export function dismissSynonymsIn(root: ShadowRoot): void {
    const set = REGISTRY.get(root)
    if (!set) return
    // copy to a fresh array: destroy() mutates the set (unregisters itself)
    for (const handle of Array.from(set)) handle.destroy()
}

function destroyExisting(root: ShadowRoot): void {
    dismissSynonymsIn(root)
    // Defensive sweep for any .gf-syn node not tracked by the registry
    // (should not happen — showSynonyms always registers — but avoids a
    // doubled popover if some future caller ever bypasses the handle
    // bookkeeping).
    root.querySelectorAll('.gf-syn').forEach((el) => el.remove())
}

function positionPopover(pop: HTMLElement, anchor: DOMRect, view: Window, clear?: DOMRect): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = pop.offsetWidth || POPOVER_WIDTH
    const height = pop.offsetHeight || POPOVER_HEIGHT_FALLBACK
    // Default: popover sits BELOW the word, centered on the word's
    // horizontal mid-point. Flip above if no room below.
    let left = anchor.left + anchor.width / 2 - width / 2
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (left + width > vw - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    // Below-placement clears the BOTTOM of the clear rect (host chrome)
    // when supplied; flip-above clears its TOP. The word rect alone is
    // not enough: in Discord the word sits inside the composer, so a
    // popover that clears the word still overlaps the composer chrome.
    const belowEdge = clear ? Math.max(anchor.bottom, clear.bottom) : anchor.bottom
    const aboveEdge = clear ? Math.min(anchor.top, clear.top) : anchor.top
    let top = belowEdge + POPOVER_GAP_BELOW
    if (top + height > vh - VIEWPORT_GUTTER) top = aboveEdge - height - POPOVER_GAP_ABOVE
    if (top < VIEWPORT_GUTTER) top = VIEWPORT_GUTTER
    debugLog('synonyms', 'position', {
        offsetHeight: pop.offsetHeight,
        usedHeight: height,
        anchorTop: anchor.top,
        clearTop: clear?.top ?? null,
        top,
        left,
    })
    pop.style.left = `${String(left)}px`
    pop.style.top = `${String(top)}px`
}

function el(parent: Node, tag: string, className?: string): HTMLElement {
    const node = document.createElement(tag)
    if (className) node.className = className
    parent.appendChild(node)
    return node
}
