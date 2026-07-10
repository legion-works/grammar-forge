// P1-7: chatbar.ts hardcodes four Legion hex literals (LEGION_ACCENT,
// LEGION_ACCENT_INK, LEGION_PURPLE, LEGION_SUCCESS) because the chatbar
// button renders in Discord's own React tree, OUTSIDE the GrammarForge
// overlay shadow root — the shared `--gf-*` custom properties the overlay
// CSS defines (clients/browser/src/overlay/styles.ts) are scoped to that
// shadow host and do not cascade there (see chatbar.ts's own comment).
// That's a documented, necessary duplication — but nothing enforced that
// the literals stayed in sync with the canonical dark-theme tokens. This
// guards against silent drift the same way view-model.test.ts's
// "P1-10: CONF_COLOR / styles.ts --gf-conf-* token sync" guards the
// confidence-bar palette (pattern mirrors opencode's
// category-palette-sync.test.ts).
import { describe, expect, it } from 'vitest'
import { OVERLAY_CSS } from '@/overlay/styles'
import {
    LEGION_ACCENT,
    LEGION_ACCENT_INK,
    LEGION_PURPLE,
    LEGION_SUCCESS,
} from './legion-palette'

// chatbar.ts's four inlined Legion dark-theme literals, imported (not
// hand-copied) so a future edit to chatbar.ts is what this test actually
// exercises.
const CHATBAR_LEGION_HEX = {
    LEGION_ACCENT,
    LEGION_ACCENT_INK,
    LEGION_PURPLE,
    LEGION_SUCCESS,
} as const

// Maps each chatbar.ts constant to its canonical --gf-* token name in the
// dark-theme :host() block of OVERLAY_CSS.
const CANONICAL_TOKEN_FOR: Record<keyof typeof CHATBAR_LEGION_HEX, string> = {
    LEGION_ACCENT: 'gf-accent',
    LEGION_ACCENT_INK: 'gf-accent-ink',
    LEGION_PURPLE: 'gf-ai-violet',
    LEGION_SUCCESS: 'gf-success',
}

describe('P1-7: chatbar.ts Legion hex literals stay in sync with overlay/styles.ts', () => {
    it('extracts a non-empty dark-theme :host() token block from OVERLAY_CSS', () => {
        const darkThemeBlock = /:host\(\[data-gf-theme="dark"\]\)\s*\{([\s\S]*?)\n {2}\}/.exec(
            OVERLAY_CSS,
        )
        expect(darkThemeBlock, 'dark-theme :host token block must exist').not.toBeNull()
        expect(darkThemeBlock![1]!.length).toBeGreaterThan(0)
    })

    it.each(Object.keys(CHATBAR_LEGION_HEX) as Array<keyof typeof CHATBAR_LEGION_HEX>)(
        'chatbar.ts %s matches the canonical --gf-* literal in OVERLAY_CSS',
        (constName) => {
            const darkThemeBlock = /:host\(\[data-gf-theme="dark"\]\)\s*\{([\s\S]*?)\n {2}\}/.exec(
                OVERLAY_CSS,
            )
            const block = darkThemeBlock![1]!
            const tokenName = CANONICAL_TOKEN_FOR[constName]
            const m = new RegExp(`--${tokenName}:\\s*(#[0-9a-fA-F]+)`).exec(block)
            expect(m, `--${tokenName} must be defined in the dark-theme token block`).not.toBeNull()
            expect(CHATBAR_LEGION_HEX[constName]).toBe(m![1])
        },
    )
})
