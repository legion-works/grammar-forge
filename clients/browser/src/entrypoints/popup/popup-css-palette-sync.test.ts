// popup.css is a plain CSS file (not a shadow root, not a TS template) —
// it can't `import` the shared `lib/legion-tokens.ts` constants, so its
// `:root` custom properties keep their own hex literals. This test is the
// enforcement mechanism that replaces "keep all three in sync when the
// SCSS changes" (the old comment in api/category.ts): it reads popup.css
// as text and asserts every Legion/category/band literal it defines
// matches the canonical `lib/legion-tokens.ts` module.
//
// Pattern mirrors clients/vencord/src/chatbar-palette-sync.test.ts (P1-7)
// and clients/opencode/src/category-palette-sync.test.ts.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BAND_COLOR, CATEGORY_COLOR, LEGION } from '@/lib/legion-tokens'

const POPUP_CSS_PATH = fileURLToPath(new URL('./popup.css', import.meta.url))
const popupCss = readFileSync(POPUP_CSS_PATH, 'utf8')

/** Extract a `{ ... }` rule body by its selector (exact string match on
 *  the selector line). Returns the raw declaration text between the
 *  braces. */
function ruleBody(css: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)
    if (!m) throw new Error(`selector not found in popup.css: ${selector}`)
    return m[1]!
}

function tokenValue(body: string, name: string): string {
    const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]+)`).exec(body)
    if (!m) throw new Error(`--${name} not found in the given popup.css rule body`)
    return m[1]!
}

describe('popup.css Legion/category/band tokens stay in sync with lib/legion-tokens.ts', () => {
    const root = ruleBody(popupCss, ':root')
    const lightOverride = ruleBody(popupCss, ":root:has(main[data-gf-theme='light'])")

    it(':root defaults match the DARK theme accent/purple values', () => {
        expect(tokenValue(root, 'gf-accent')).toBe(LEGION.dark.accent)
        expect(tokenValue(root, 'gf-accent-ink')).toBe(LEGION.dark.accentInk)
        expect(tokenValue(root, 'gf-ai-violet')).toBe(LEGION.dark.purple)
    })

    it("the light-theme override matches LEGION.light's accent values", () => {
        expect(tokenValue(lightOverride, 'gf-accent')).toBe(LEGION.light.accent)
        expect(tokenValue(lightOverride, 'gf-accent-hover')).toBe(LEGION.light.accentHover)
        expect(tokenValue(lightOverride, 'gf-accent-ink')).toBe(LEGION.light.accentInk)
    })

    it('--gf-cat-* matches CATEGORY_COLOR[*].badge for every token popup.css defines', () => {
        expect(tokenValue(root, 'gf-cat-spelling')).toBe(CATEGORY_COLOR.spelling.badge)
        expect(tokenValue(root, 'gf-cat-grammar')).toBe(CATEGORY_COLOR.grammar.badge)
        expect(tokenValue(root, 'gf-cat-punctuation')).toBe(CATEGORY_COLOR.punctuation.badge)
        expect(tokenValue(root, 'gf-cat-style')).toBe(CATEGORY_COLOR.style.badge)
        expect(tokenValue(root, 'gf-cat-typography')).toBe(CATEGORY_COLOR.typography.badge)
    })

    it('--gf-band-* matches BAND_COLOR for every token popup.css defines', () => {
        expect(tokenValue(root, 'gf-band-excellent')).toBe(BAND_COLOR.excellent)
        expect(tokenValue(root, 'gf-band-good')).toBe(BAND_COLOR.good)
        expect(tokenValue(root, 'gf-band-fair')).toBe(BAND_COLOR.fair)
        expect(tokenValue(root, 'gf-band-needswork')).toBe(BAND_COLOR['needs-work'])
    })
})
