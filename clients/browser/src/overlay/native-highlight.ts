// Document-global CSS Custom Highlight API registry. For contenteditable fields
// (Discord / WhatsApp / Lexical / rich editors) the browser tracks reflow /
// scroll / wrapping natively when a `::highlight()` rule references a Range —
// crisper than our overlay rects, no re-measure on scroll/resize. `<textarea>`
// and `<input>` keep the overlay path: the API can't reach inside form
// controls. Falls back to overlay for everyone when the API is missing
// (`isNativeHighlightSupported()` is false).
//
// The registry is GLOBAL to a document: `CSS.highlights` is a single Map keyed
// by string. We share highlight names across fields ("gf-spelling" idle,
// "gf-spelling-strong" for the focused field, "gf-hover" for the single
// hovered item) and bucket ranges per field internally. Field/focus changes
// call `rebuildCategories()` (clears + repopulates gf-<cat> / gf-<cat>-strong);
// hover calls only `applyHover()` (touches gf-hover). That's the contract the
// tests pin: keys + range counts + object identity after hover.
//
// On first use we inject a `<style id="gf-native-highlights">` into the page's
// <head> with `::highlight()` rules for every category (idle / strong / hover
// alpha ladder, light + dark via prefers-color-scheme). The injected style
// lives in PAGE scope — `::highlight()` rules are not scoped to a shadow root.
// `destroy()` removes the style and clears every entry we wrote.

import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'
import { codeUnitSpanToRange } from '@/input/text'

/** Feature-detect the CSS Custom Highlight API. */
export function isNativeHighlightSupported(): boolean {
    return (
        typeof CSS !== 'undefined' &&
        'highlights' in CSS &&
        typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
    )
}

export interface NativeHighlightItem {
    cuStart: number
    cuEnd: number
    category: Category
}

interface FieldEntry {
    /** All ranges for this field, in item order (parallel to NativeHighlightItem[]). */
    items: Array<{ item: NativeHighlightItem; range: Range | null }>
}

export interface NativeHighlighter {
    /** Replace this field's items; rebuilds category buckets + reapplies hover. Skips null ranges. */
    setFieldHighlights: (el: HTMLElement, items: readonly NativeHighlightItem[]) => void
    /** Mark one field as focused — its ranges go into the `-strong` bucket. */
    setFocusedField: (el: HTMLElement | null) => void
    /** Highlight the single item at `itemIndex` in `el` (or clear with null). */
    setHoverItem: (el: HTMLElement, itemIndex: number | null) => void
    /** Remove this field's ranges from the registry. */
    clearField: (el: HTMLElement) => void
    /** Remove all entries + the injected style. Idempotent. */
    destroy: () => void
}

const STYLE_ID = 'gf-native-highlights'
// Alpha ladder — MUST stay in lock-step with the overlay path's
// `.gf-highlight` / `--focus` / `--hover` color-mix percentages in styles.ts,
// or textarea (overlay) and contenteditable (native) highlights visibly differ.
const IDLE_ALPHA = 20
const STRONG_ALPHA = 24
const HOVER_ALPHA = 42

function registry(): Map<string, Highlight> | null {
    if (!isNativeHighlightSupported()) return null
    return (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
}

function ensureStyleInjected(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = buildStyleSheet()
    doc.head.appendChild(style)
}

function buildStyleSheet(): string {
    const cats = Object.keys(CATEGORY_META) as Category[]
    const light: string[] = []
    for (const cat of cats) {
        const color = CATEGORY_META[cat].tint
        light.push(
            `::highlight(gf-${cat}) { background-color: color-mix(in srgb, ${color} ${IDLE_ALPHA}%, transparent); }`,
        )
        light.push(
            `::highlight(gf-${cat}-strong) { background-color: color-mix(in srgb, ${color} ${STRONG_ALPHA}%, transparent); }`,
        )
    }
    // Hover rule (single, neutral). Use a generic gray-blue mix so the hover
    // band reads as "this word" against any category tint.
    const hoverRule = `::highlight(gf-hover) { background-color: color-mix(in srgb, #1f2937 ${HOVER_ALPHA}%, transparent); }`
    const hoverRuleDark = `::highlight(gf-hover) { background-color: color-mix(in srgb, #e5e7eb ${HOVER_ALPHA}%, transparent); }`
    // The dark block: re-derive idle with a slightly higher alpha so dark
    // backgrounds still register. (We could re-list per category, but a
    // blanket tweak is cheaper and the visual delta is the point.)
    const darkIdle = cats
        .map(
            (cat) =>
                `::highlight(gf-${cat}) { background-color: color-mix(in srgb, ${CATEGORY_META[cat].tint} ${IDLE_ALPHA + 4}%, transparent); }`,
        )
        .join('\n')
    return [
        light.join('\n'),
        hoverRule,
        `@media (prefers-color-scheme: dark) {\n${darkIdle}\n${hoverRuleDark}\n}`,
    ].join('\n')
}

function makeHighlighter(doc: Document): NativeHighlighter {
    const fields = new Map<HTMLElement, FieldEntry>()
    let focused: HTMLElement | null = null
    let hover: { el: HTMLElement; index: number } | null = null
    // Tracked alongside `hover` so applyHover() can paint the registry in O(1)
    // without re-walking `fields`. Updated by setFieldHighlights / setHoverItem
    // / clearField; cleared on destroy.
    let hoverRange: Range | null = null

    // Rebuild ONLY the per-category buckets (gf-<cat> / gf-<cat>-strong).
    // Called on field/focus changes — NOT on hover.
    const rebuildCategories = (): void => {
        if (!isNativeHighlightSupported()) return
        ensureStyleInjected(doc)
        const reg = registry()
        if (!reg) return
        // Clear our category entries only. Leave `gf-hover` and any other
        // consumer's entries alone.
        for (const key of Array.from(reg.keys())) {
            if (key.startsWith('gf-') && key !== 'gf-hover') reg.delete(key)
        }
        if (fields.size === 0) return

        // Bucket ranges by (category, isFocused). A field's ranges go into the
        // idle bucket (or -strong if it IS the focused field).
        const idleByCat = new Map<Category, Range[]>()
        const strongByCat = new Map<Category, Range[]>()
        for (const [el, entry] of fields) {
            const isFoc = el === focused
            for (const { item, range } of entry.items) {
                if (!range) continue
                const bucket = isFoc ? strongByCat : idleByCat
                let arr = bucket.get(item.category)
                if (!arr) {
                    arr = []
                    bucket.set(item.category, arr)
                }
                arr.push(range)
            }
        }
        for (const [cat, ranges] of idleByCat) {
            reg.set(`gf-${cat}`, new Highlight(...ranges))
        }
        for (const [cat, ranges] of strongByCat) {
            reg.set(`gf-${cat}-strong`, new Highlight(...ranges))
        }
    }

    // Apply ONLY the single hover highlight (O(1)). Touches one registry key.
    const applyHover = (): void => {
        if (!isNativeHighlightSupported()) return
        const reg = registry()
        if (!reg) return
        if (hoverRange) reg.set('gf-hover', new Highlight(hoverRange))
        else reg.delete('gf-hover')
    }

    return {
        setFieldHighlights(el, items) {
            if (!isNativeHighlightSupported()) return
            ensureStyleInjected(doc)
            // M6: skip when nothing to do (already-empty field, empty list).
            if (items.length === 0 && !fields.has(el)) return
            const built: FieldEntry['items'] = items.map((it) => ({
                item: it,
                range: codeUnitSpanToRange(el, { start: it.cuStart, end: it.cuEnd }),
            }))
            fields.set(el, { items: built })
            // Hover is anchored by (el, index) — re-validate its range / index.
            if (hover && hover.el === el) {
                const r = built[hover.index]?.range ?? null
                hoverRange = r
                if (!r) hover = null
            }
            rebuildCategories()
            applyHover()
        },
        setFocusedField(el) {
            if (!isNativeHighlightSupported()) {
                focused = null
                return
            }
            if (el === focused) return
            focused = el
            rebuildCategories()
        },
        setHoverItem(el, index) {
            if (!isNativeHighlightSupported()) {
                hover = null
                hoverRange = null
                return
            }
            // M5: no-op guard — same (el, index) twice, or clearing when already
            // clear. Skip the registry write entirely.
            if ((hover?.el === el && hover?.index === index) || (index == null && !hover)) return
            if (index == null) {
                hover = null
                hoverRange = null
            } else {
                hover = { el, index }
                hoverRange = fields.get(el)?.items[index]?.range ?? null
            }
            applyHover()
        },
        clearField(el) {
            if (!fields.delete(el)) return
            if (focused === el) focused = null
            if (hover?.el === el) {
                hover = null
                hoverRange = null
            }
            rebuildCategories()
            applyHover()
        },
        destroy() {
            fields.clear()
            focused = null
            hover = null
            hoverRange = null
            if (isNativeHighlightSupported()) {
                const reg = registry()
                if (reg) {
                    for (const key of Array.from(reg.keys())) {
                        if (key.startsWith('gf-')) reg.delete(key)
                    }
                }
            }
            doc.getElementById(STYLE_ID)?.remove()
        },
    }
}

interface NativeHighlighterState {
    instance: NativeHighlighter | null
    doc: Document | null
}

/** No-op highlighter used when the API is missing — keeps the orchestrator
 *  unconditional (`getNativeHighlighter().destroy()` always works). */
function makeNoopHighlighter(): NativeHighlighter {
    const noop = (): void => {}
    return {
        setFieldHighlights: noop,
        setFocusedField: noop,
        setHoverItem: noop,
        clearField: noop,
        destroy: noop,
    }
}

/**
 * Return the document-scoped singleton. Tests that need a clean instance can
 * call `destroy()` on the previous one; the next call creates a fresh one.
 * Production code uses the same instance for the lifetime of the content
 * script (it survives across checks; only `destroy()` on teardown drops it).
 *
 * Returns a no-op highlighter when the CSS Custom Highlight API is
 * unavailable (e.g. Firefox/older browsers) so the orchestrator can call
 * `destroy()` unconditionally without injecting a `<style>` or touching
 * `CSS.highlights`.
 */
export function getNativeHighlighter(doc: Document = document): NativeHighlighter {
    if (!isNativeHighlightSupported()) return makeNoopHighlighter()
    const state: NativeHighlighterState = (
        globalThis as { __gfNativeHlState?: NativeHighlighterState }
    ).__gfNativeHlState ?? {
        instance: null,
        doc: null,
    }
    if (!state.instance || state.doc !== doc) {
        state.instance = makeHighlighter(doc)
        state.doc = doc
        ;(globalThis as { __gfNativeHlState?: NativeHighlighterState }).__gfNativeHlState = state
    }
    return state.instance
}
