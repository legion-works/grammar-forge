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
// hovered item) and bucket ranges per field internally; every state change
// triggers a full `rebuild()` that clears our entries and repopulates them.
// That's the contract the tests pin: keys + range counts.
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
    /** Replace this field's items; rebuilds the registry. Skips null ranges. */
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
const IDLE_ALPHA = 12
const STRONG_ALPHA = 20
const HOVER_ALPHA = 32

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

    const rebuild = (): void => {
        if (!isNativeHighlightSupported()) return
        ensureStyleInjected(doc)
        const reg = registry()
        if (!reg) return
        // Clear our entries. Leave any other consumer's entries alone.
        for (const key of Array.from(reg.keys())) {
            if (key.startsWith('gf-')) reg.delete(key)
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
        // Single hover range.
        if (hover) {
            const entry = fields.get(hover.el)
            const item = entry?.items[hover.index]
            if (item?.range) {
                reg.set('gf-hover', new Highlight(item.range))
            }
        }
    }

    return {
        setFieldHighlights(el, items) {
            if (!isNativeHighlightSupported()) return
            const built: FieldEntry['items'] = items.map((it) => ({
                item: it,
                range: codeUnitSpanToRange(el, { start: it.cuStart, end: it.cuEnd }),
            }))
            fields.set(el, { items: built })
            // Hover is anchored by (el, index) — re-validate it's still in range.
            if (
                hover &&
                hover.el === el &&
                (hover.index >= built.length || !built[hover.index]?.range)
            ) {
                hover = null
            }
            rebuild()
        },
        setFocusedField(el) {
            if (!isNativeHighlightSupported()) {
                focused = null
                return
            }
            focused = el
            rebuild()
        },
        setHoverItem(el, index) {
            if (!isNativeHighlightSupported()) {
                hover = null
                return
            }
            hover = index == null ? null : { el, index }
            rebuild()
        },
        clearField(el) {
            if (!fields.delete(el)) return
            if (focused === el) focused = null
            if (hover?.el === el) hover = null
            rebuild()
        },
        destroy() {
            fields.clear()
            focused = null
            hover = null
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
