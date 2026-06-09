// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATEGORY_META } from '@/api/category'
import { getNativeHighlighter, isNativeHighlightSupported } from '@/overlay/native-highlight'

// Highlight in lib.dom.d.ts does NOT expose its ranges as a public property —
// it only has `forEach(callback, thisArg?)`. We read range counts via the
// public API so the tests don't rely on internals the spec doesn't promise.
const rangeCount = (h: Highlight): number => {
    let n = 0
    h.forEach(() => {
        n++
    })
    return n
}

// jsdom has no CSS Custom Highlight API. We install a minimal stub for each
// test and tear it down after. The real browser impl guards every access
// behind `isNativeHighlightSupported()` so the stub lets the production
// code run in tests without monkey-patching production modules.

class FakeHighlight {
    ranges: AbstractRange[]
    constructor(...ranges: AbstractRange[]) {
        this.ranges = ranges
    }
    // Match the real Highlight interface (lib.dom.d.ts) so test helpers can
    // iterate ranges via the public API the spec promises.
    forEach(callbackfn: (value: AbstractRange) => void): void {
        for (const r of this.ranges) callbackfn(r)
    }
}

const mkRegistry = (): Map<string, Highlight> => new Map<string, Highlight>()

const installHighlightStub = (): void => {
    ;(globalThis as unknown as { Highlight: typeof FakeHighlight }).Highlight = FakeHighlight
    // jsdom's `CSS` global may be undefined; create it on globalThis so
    // `typeof CSS !== 'undefined'` passes and `.highlights` is a real Map.
    ;(globalThis as unknown as { CSS: { highlights: Map<string, Highlight> } }).CSS = {
        highlights: mkRegistry(),
    }
}

const removeHighlightStub = (): void => {
    delete (globalThis as unknown as { Highlight?: typeof FakeHighlight }).Highlight
    delete (globalThis as unknown as { CSS?: { highlights: Map<string, Highlight> } }).CSS
}

const mkField = (html: string): HTMLElement => {
    const d = document.createElement('div')
    d.setAttribute('contenteditable', 'true')
    d.innerHTML = html
    document.body.appendChild(d)
    return d
}

// Each field gets text into a single text node for deterministic ranges.
const field = (): HTMLElement => mkField('the teh cat')

describe('isNativeHighlightSupported', () => {
    afterEach(removeHighlightStub)

    it('returns false when CSS.highlights and Highlight are absent (jsdom default)', () => {
        expect(isNativeHighlightSupported()).toBe(false)
    })

    it('returns true when the stub is installed', () => {
        installHighlightStub()
        expect(isNativeHighlightSupported()).toBe(true)
    })
})

describe('getNativeHighlighter (with stub)', () => {
    beforeEach(() => {
        installHighlightStub()
        // Force a fresh instance per test so internal Map state is clean.
        // The module-level memoization is bypassed by deleting the previous
        // instance via destroy() + reconstructing via the factory.
    })

    afterEach(() => {
        // Destroy FIRST (while the stub is still in place — destroy needs
        // the live registry to clear it) then tear down the stub. Reversed
        // order would call destroy via the no-op fallback (since
        // isNativeHighlightSupported returns false without the stub) and
        // leak the cached instance's fields Map into the next test.
        getNativeHighlighter().destroy()
        removeHighlightStub()
    })

    it('returns a singleton bound to the current document', () => {
        const a = getNativeHighlighter()
        const b = getNativeHighlighter()
        expect(a).toBe(b)
    })

    it('setFieldHighlights populates the registry with per-category highlights', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [
            { cuStart: 0, cuEnd: 3, category: 'spelling' },
            { cuStart: 4, cuEnd: 7, category: 'grammar' },
        ])
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        // Only the idle names are populated when no field is focused.
        expect(reg.has('gf-spelling')).toBe(true)
        expect(reg.has('gf-grammar')).toBe(true)
        expect(reg.has('gf-spelling-strong')).toBe(false)
        expect(reg.has('gf-grammar-strong')).toBe(false)
        const spelling = reg.get('gf-spelling')!
        const grammar = reg.get('gf-grammar')!
        expect(rangeCount(spelling)).toBe(1)
        expect(rangeCount(grammar)).toBe(1)
    })

    it('setFocusedField moves the field ranges into the -strong names', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [
            { cuStart: 0, cuEnd: 3, category: 'spelling' },
            { cuStart: 4, cuEnd: 7, category: 'grammar' },
        ])
        h.setFocusedField(el)
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        // Focused field's ranges go into -strong; idle names empty → not set.
        expect(reg.has('gf-spelling-strong')).toBe(true)
        expect(reg.has('gf-grammar-strong')).toBe(true)
        expect(reg.has('gf-spelling')).toBe(false)
        expect(reg.has('gf-grammar')).toBe(false)
        expect(rangeCount(reg.get('gf-spelling-strong')!)).toBe(1)
        expect(rangeCount(reg.get('gf-grammar-strong')!)).toBe(1)
    })

    it('clearing focus moves ranges back into the idle names', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [{ cuStart: 0, cuEnd: 3, category: 'spelling' }])
        h.setFocusedField(el)
        h.setFocusedField(null)
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        expect(reg.has('gf-spelling')).toBe(true)
        expect(reg.has('gf-spelling-strong')).toBe(false)
    })

    it('setHoverItem puts a single range into gf-hover', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [
            { cuStart: 0, cuEnd: 3, category: 'spelling' },
            { cuStart: 4, cuEnd: 7, category: 'grammar' },
        ])
        h.setHoverItem(el, 1)
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        expect(reg.has('gf-hover')).toBe(true)
        expect(rangeCount(reg.get('gf-hover')!)).toBe(1)
        // Hover is the focused-field's grammar item; focus set first to confirm
        // hover still works (range is sourced from the per-field map, not the
        // active idle/strong bucket).
        h.setFocusedField(el)
        h.setHoverItem(el, 0)
        expect(reg.has('gf-hover')).toBe(true)
        expect(rangeCount(reg.get('gf-hover')!)).toBe(1)
        h.setHoverItem(el, null)
        expect(reg.has('gf-hover')).toBe(false)
    })

    it("clearField removes that field's ranges from the registry", () => {
        const a = field()
        const b = mkField('another teh word')
        const h = getNativeHighlighter()
        h.setFieldHighlights(a, [{ cuStart: 0, cuEnd: 3, category: 'spelling' }])
        h.setFieldHighlights(b, [{ cuStart: 0, cuEnd: 7, category: 'grammar' }])
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        expect(reg.has('gf-spelling')).toBe(true)
        expect(reg.has('gf-grammar')).toBe(true)
        h.clearField(a)
        expect(reg.has('gf-spelling')).toBe(false)
        // b untouched
        expect(reg.has('gf-grammar')).toBe(true)
    })

    it('destroy clears all our entries and removes the injected <style>', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [{ cuStart: 0, cuEnd: 3, category: 'spelling' }])
        // The <style> should have been injected on first use.
        expect(document.getElementById('gf-native-highlights')).toBeTruthy()
        h.destroy()
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        // Only the gf-* entries the registry KNOWS about get cleared; the
        // global Map itself isn't emptied (other consumers may have their
        // own names), so assert that no gf-* entry remains.
        for (const key of reg.keys()) {
            expect(key.startsWith('gf-')).toBe(false)
        }
        expect(document.getElementById('gf-native-highlights')).toBeNull()
    })

    it('injects <style> on first use with ::highlight rules for every category', () => {
        const el = field()
        const h = getNativeHighlighter()
        h.setFieldHighlights(el, [{ cuStart: 0, cuEnd: 3, category: 'spelling' }])
        const style = document.getElementById('gf-native-highlights') as HTMLStyleElement | null
        expect(style).toBeTruthy()
        const css = style?.textContent ?? ''
        // Every Category has a highlight name + -strong + hover rule.
        for (const cat of Object.keys(CATEGORY_META) as Array<keyof typeof CATEGORY_META>) {
            expect(css).toContain(`::highlight(gf-${cat})`)
            expect(css).toContain(`::highlight(gf-${cat}-strong)`)
        }
        expect(css).toContain('::highlight(gf-hover)')
        // At least the prefers-color-scheme media block is present.
        expect(css).toContain('prefers-color-scheme')
    })

    it('does nothing destructive when fields are empty (still injects style once)', () => {
        const h = getNativeHighlighter()
        h.setFieldHighlights(field(), [])
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        // No ranges → no entries written.
        for (const key of reg.keys()) {
            expect(key.startsWith('gf-')).toBe(false)
        }
        // Style still injected for first-use.
        expect(document.getElementById('gf-native-highlights')).toBeTruthy()
    })

    it('skips out-of-range spans (null Range from codeUnitSpanToRange)', () => {
        const el = mkField('hi')
        const h = getNativeHighlighter()
        // cuEnd beyond the text length → codeUnitSpanToRange returns null.
        h.setFieldHighlights(el, [{ cuStart: 0, cuEnd: 99, category: 'spelling' }])
        const reg = (CSS as unknown as { highlights: Map<string, Highlight> }).highlights
        expect(reg.has('gf-spelling')).toBe(false)
    })
})
