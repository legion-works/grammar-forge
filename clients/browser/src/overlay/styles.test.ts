// @vitest-environment jsdom
// CSS-string assertions for OVERLAY_CSS. Visual layout can't be jsdom-tested
// (no real layout engine), but the load-bearing CSS invariants — the .gf-orb
// 44×44 sizing (DC: orbSize = z(46,40)), the .gf-card Popover-API override, the .gf-panel-aside fixed
// positioning, the .gf-u is-on tint — CAN be asserted against the string.
// These tests would have caught all three W2 live bugs.
import { describe, expect, it } from 'vitest'
import { OVERLAY_CSS } from '@/overlay/styles'

describe('OVERLAY_CSS (W2 design system shadow-root CSS)', () => {
    describe('.gf-orb (score orb)', () => {
        it('constrains the orb to 44×44 (DC: orbSize = z(46,40); reduced from 60 in round 6)', () => {
            // The DC specifies orbSize = z(46, 40) — 46px desktop, 40px mobile.
            // We use 44px as the fixed size. The explicit size must be set so
            // the orb doesn't grow to fit its SVG child.
            const rule = /\.gf-orb\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-orb must set width:44px + height:44px').not.toBeNull()
        })

        it('is position: fixed (not absolute) so the orb anchors to the viewport', () => {
            // The W2 .gf-orb at the bottom of styles.ts uses `position:`
            // via inheritance. The W1 .gf-orb sets position: fixed. The
            // shadow host is at (0,0) of the viewport, so absolute vs fixed
            // is equivalent here — but fixed is the honest declaration for
            // a viewport-anchored surface. Without position: fixed, the
            // orb renders at (0,0) of the shadow host (which is 0,0 of
            // the viewport here, but the W2 Vencord override is absolute
            // so this is the load-bearing rule).
            const rule = /\.gf-orb\s*\{[^}]*position:\s*fixed/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-orb must be position: fixed').not.toBeNull()
        })

        it('has pointer-events: auto (shadow host is pointer-events:none; orb must opt back in)', () => {
            // Bug-fix B: the shadow host has `pointer-events: none` so the
            // overlay never blocks the page. Every interactive surface must
            // opt back in with `pointer-events: auto`. The pre-redesign
            // .gf-pill carried this explicitly (styles.ts line ~136 on
            // master). The W2 .gf-orb omitted it → the orb was invisible
            // to mouse events and the click handler never fired.
            const rule = /\.gf-orb\s*\{[^}]*pointer-events:\s*auto/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-orb must set pointer-events: auto').not.toBeNull()
        })

        it('does not position via transform translate (W2 design system uses left/top)', () => {
            // The W1 status-button.ts set `transform: translate(x, y)` to
            // position the orb (composited, no reflow). The W2 design
            // system uses `transform: scale(1.06)` on :hover — both target
            // the `transform` property, so the W1 approach clobbered the
            // W2 hover scale. The orb now positions via inline `left/top`
            // and the transform is free for the hover/active scale.
            // This test guards against reverting back to translate-based
            // positioning.
            // Match `transform:` followed by `translate(...)` as a value
            // (not a comment word). The W1 comment mentions "transform:
            // translate" in prose, so we strip comments first to avoid
            // a false positive.
            const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
            const rule = /\.gf-orb\s*\{[^}]*transform:\s*translate\(/s.exec(stripped)
            expect(rule, '.gf-orb must NOT position via transform: translate(...)').toBeNull()
        })
    })

    describe('.gf-card (correction popover, the W1 .gf-panel re-skin)', () => {
        it('resets the Popover-API default centering (margin: 0; inset: auto;)', () => {
            // Bug-fix: when a popover is promoted to the top layer via
            // `popover=manual` + showPopover(), the UA stylesheet applies
            // `inset: 0; margin: auto;` which CENTERS the popover in the
            // viewport. The W1 .gf-panel + .gf-rephrase-card carry the
            // `margin: 0; inset: auto;` override; the W2 .gf-card rule
            // originally OMITTED it — so the popover jumped to the center
            // of the viewport (visually "at the top of the page") instead
            // of anchoring to the word. Reset both so the JS left/top wins.
            const rule = /\.gf-card\s*\{[^}]*margin:\s*0[^}]*inset:\s*auto/s.exec(OVERLAY_CSS)
            expect(
                rule,
                '.gf-card must reset margin: 0 + inset: auto to override the Popover API centering',
            ).not.toBeNull()
        })

        it('is position: fixed (not absolute) to match .gf-panel + .gf-rephrase-card', () => {
            // The W2 .gf-card originally used position: absolute. The
            // shadow host is at (0,0) of the viewport so this works, but
            // the W1 .gf-panel + .gf-rephrase-card use position: fixed
            // (the honest declaration for a viewport-anchored surface).
            // Fixed is required for the popover to anchor correctly when
            // the shadow host's positioning context changes.
            const rule = /\.gf-card\s*\{[^}]*position:\s*fixed/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-card must be position: fixed').not.toBeNull()
        })

        it('has pointer-events: auto (shadow host is pointer-events:none; card must opt back in)', () => {
            // Bug-fix B: the shadow host has pointer-events:none so the
            // overlay never blocks the page. Every interactive surface
            // must opt back in with pointer-events:auto. The W2 .gf-card
            // omitted this → the card was unclickable (buttons inside it
            // never fired). The W1 .gf-panel carries pointer-events:auto.
            const rule = /\.gf-card\s*\{[^}]*pointer-events:\s*auto/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-card must set pointer-events: auto').not.toBeNull()
        })

        it('has a base font declaration (never inherits the host page font-size)', () => {
            // Bug-fix B: without an explicit font, .gf-card inherits the
            // host page's font-size (Fastmail ~16px → huge text, ~980px
            // apparent width). The :host sets 13px but the card is in the
            // top layer (popover) which may not inherit :host styles.
            // An explicit font: ... on .gf-card is the safe guard.
            const rule = /\.gf-card\s*\{[^}]*font:\s*500\s*13px/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-card must set an explicit base font (500 13px/...)').not.toBeNull()
        })

        it('has a glass background (not transparent — never inherits the page background)', () => {
            // Bug-fix B: without background, the card is transparent and
            // the page content shows through. The glass scrim must be
            // declared on .gf-card itself (not just on .gf-surface).
            const rule = /\.gf-card\s*\{[^}]*background:/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-card must set a background').not.toBeNull()
        })

        it('has a width cap (320px) so it never fills the viewport', () => {
            // Bug-fix B: without width, the card stretches to fill its
            // containing block. The DC specifies 360px (desktop) / 312px
            // (mobile); the implementation uses 320px (between the two).
            const rule = /\.gf-card\s*\{[^}]*width:\s*320px/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-card must set width: 320px').not.toBeNull()
        })
    })

    describe('.gf-panel-aside (W2b review panel)', () => {
        it('is position: fixed so the JS left/top anchors to the viewport', () => {
            const rule = /\.gf-panel-aside\s*\{[^}]*position:\s*fixed/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-panel-aside must be position: fixed').not.toBeNull()
        })

        it('constrains the width to 344px (W2b design)', () => {
            const rule = /\.gf-panel-aside\s*\{[^}]*width:\s*344px/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-panel-aside must set width: 344px').not.toBeNull()
        })

        it('has a high-opacity base background (≥0.90 alpha) so page text does not bleed through', () => {
            // Bug-fix: the panel was 0.78 alpha → page text bled through.
            // DC reference: dark = rgba(58,62,72,0.80)/rgba(33,36,43,0.74)
            // gradient; light = rgba(255,255,255,0.95)/rgba(255,255,255,0.80).
            // The base (non-@supports) background must be ≥0.90 so the panel
            // is readable even without backdrop-filter support.
            // We check for 0.9x or 0.95 in the base background declaration.
            const rule = /\.gf-panel-aside\s*\{[^}]*background:[^;]*0\.9[0-9]/s.exec(OVERLAY_CSS)
            expect(
                rule,
                '.gf-panel-aside base background must have alpha ≥ 0.90 (was 0.78 → page text bled through)',
            ).not.toBeNull()
        })

        it('has a @supports backdrop-filter glass upgrade', () => {
            // The @supports block upgrades the panel to the full glass recipe
            // (gradient background + blur) when backdrop-filter is available.
            // Without it the panel stays at the base solid scrim.
            const rule = /@supports[^{]*backdrop-filter[^{]*\{[^}]*\.gf-panel-aside/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-panel-aside must have a @supports backdrop-filter upgrade block').not.toBeNull()
        })
    })

    describe('.gf-u (per-span highlight)', () => {
        it('renders a visible underline via SVG mask ::after (NOT border-bottom wavy)', () => {
            // ROOT CAUSE FIX (round 7): border-bottom: 1.7px wavy was INVALID CSS.
            // 'wavy' is only valid for text-decoration-style, NOT border-style.
            // The entire shorthand was silently dropped -> no underline rendered.
            //
            // FIX: SVG wave via CSS mask on .gf-u::after. The ::after strip
            // sits at bottom:-2px, 4px tall, masked to a sine-wave shape.
            // background-color = var(--gf-hl) so one mask works for all categories.
            //
            // Assert: NO .gf-u rule uses 'wavy' as a border-style.
            const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
            expect(
                /\.gf-u[^{]*\{[^}]*border[^}]*wavy/s.test(stripped),
                '.gf-u must NOT use border-style: wavy (invalid CSS — silently dropped)',
            ).toBe(false)
            // Assert: the underline mechanism is present (mask-image on ::after).
            const hasMask = /\.gf-u::after[^{]*\{[^}]*mask-image/s.test(stripped)
            expect(hasMask, '.gf-u::after must set mask-image for the wave underline').toBe(true)
            // Assert: background-color uses --gf-hl (the category color variable).
            const hasBgColor = /\.gf-u::after[^{]*\{[^}]*background-color:\s*var\(--gf-hl\)/s.test(stripped)
            expect(hasBgColor, '.gf-u::after must set background-color: var(--gf-hl)').toBe(true)
        })

        it('does NOT use text-decoration for the underline (text-decoration does not render on empty divs)', () => {
            // Regression guard: text-decoration: underline wavy does NOT render
            // on empty <div> elements (the highlight nodes). This caused all
            // GF underlines to be invisible. The underline must use mask/background.
            const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
            const gfUBlock = /\.gf-u\s*\{([^}]*)\}/gs
            let match: RegExpExecArray | null
            let foundTextDecorationUnderline = false
            while ((match = gfUBlock.exec(stripped)) !== null) {
                const block = match[1] ?? ''
                if (/text-decoration:\s*underline/.test(block)) {
                    foundTextDecorationUnderline = true
                }
            }
            expect(
                foundTextDecorationUnderline,
                '.gf-u must NOT use text-decoration: underline (does not render on empty divs)',
            ).toBe(false)
        })

        it('drives a 22% tint via .is-on (per-category + generic)', () => {
            // The .gf-u.is-on + .gf-u--<cat>.is-on produce a 22% tinted
            // background on hover/active. If either rule is removed, the hover
            // tint breaks.
            const generic = /\.gf-u\.is-on\s*\{[^}]*background:/s.exec(OVERLAY_CSS)
            expect(generic, '.gf-u.is-on must set a background tint').not.toBeNull()
            const perCat = /\.gf-u--spelling\.is-on\s*\{[^}]*background:/s.exec(OVERLAY_CSS)
            expect(perCat, '.gf-u--spelling.is-on must set a background tint').not.toBeNull()
        })

        it('.gf-tip is position: fixed with z-index at Z_OVERLAY (not position:absolute z-index:30)', () => {
            // Bug-fix: .gf-tip was position:absolute z-index:30. The highlight
            // nodes are position:fixed at z-index:2147483647 — the tooltip was
            // rendered BEHIND them and invisible. Must be position:fixed at the
            // same z-index as other overlay surfaces.
            const rule = /\.gf-tip\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*2147483647/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-tip must be position:fixed z-index:2147483647').not.toBeNull()
        })
    })

    describe('P1-4: animation/spec-violation cleanup', () => {
        it('.gf-rephrase-btn and .gf-rephrase have a static opacity:1 fallback (match .gf-goals-pop)', () => {
            // (a) Both rely on the gf-popover-enter keyframe (from { opacity: 0 }).
            // Without a static opacity:1 outside the animation, a reduced-motion
            // or otherwise non-animating context strands the surface invisible.
            const btn = /\.gf-rephrase-btn\s*\{[^}]*opacity:\s*1/s.exec(OVERLAY_CSS)
            expect(btn, '.gf-rephrase-btn must set a static opacity: 1 fallback').not.toBeNull()
            const card = /\.gf-rephrase\s*\{[^}]*opacity:\s*1/s.exec(OVERLAY_CSS)
            expect(card, '.gf-rephrase must set a static opacity: 1 fallback').not.toBeNull()
        })

        it('every animation: reference points at a keyframe that is actually defined', () => {
            // (d) gf-pill-enter was referenced by .gf-tooltip / .gf-toast but
            // never defined anywhere — a silent no-op. Guard against any
            // dangling `animation: <name>` reference regressing back in.
            const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
            const definedNames = new Set(
                Array.from(stripped.matchAll(/@keyframes\s+([\w-]+)/g)).map((m) => m[1]),
            )
            const referencedNames = new Set(
                Array.from(stripped.matchAll(/animation(?:-name)?:\s*([\w-]+)/g))
                    .map((m) => m[1])
                    .filter((name) => name !== 'none'),
            )
            for (const name of referencedNames) {
                expect(definedNames.has(name), `@keyframes ${name} must be defined (referenced by animation)`).toBe(
                    true,
                )
            }
            expect(referencedNames.has('gf-pill-enter')).toBe(false)
        })

        it('.gf-toast uses a real, defined entrance keyframe (not the historical gf-pill-enter no-op)', () => {
            const rule = /\.gf-toast\s*\{[^}]*animation:\s*([\w-]+)/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-toast must declare an animation').not.toBeNull()
            expect(rule![1]).not.toBe('gf-pill-enter')
            expect(new RegExp(`@keyframes\\s+${rule![1]}\\b`).test(OVERLAY_CSS)).toBe(true)
        })

        it('reduced-motion kills .gf-rephrase / .gf-rephrase-btn / .gf-toast animation outright (no backwards opacity-fade swap)', () => {
            // (c)+(d): gf-no-motion fades opacity 0 -> 1, which is backwards for
            // a reduced-motion override on a surface that already renders at
            // opacity:1 (or has no opacity dependency) — match .gf-orb's
            // existing `animation: none` treatment instead.
            const reducedMotionBlock = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n  \}/.exec(
                OVERLAY_CSS,
            )
            expect(reducedMotionBlock, 'prefers-reduced-motion block must exist').not.toBeNull()
            const block = reducedMotionBlock![1]!
            for (const cls of ['.gf-rephrase-btn', '.gf-rephrase', '.gf-toast']) {
                expect(block.includes(cls), `reduced-motion block must cover ${cls}`).toBe(true)
            }
            expect(/gf-no-motion/.test(block), 'reduced-motion block must not swap in gf-no-motion').toBe(false)
        })

        it('deletes dead legacy W1 selectors (.gf-panel, .gf-pill-panel, legacy .gf-tooltip, .gf-rephrase-card, .gf-toast__action)', () => {
            // (e) Each of these was verified unreferenced by any browser/vencord
            // JS (the live DOM classes are .gf-card, .gf-panel-aside, .gf-tip,
            // .gf-rephrase, .gf-btn-soft respectively). Strip comments first —
            // the classes are legitimately still named in explanatory prose
            // (e.g. "DOM class is .gf-rephrase, NOT .gf-rephrase-card").
            const stripped = OVERLAY_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
            expect(/\.gf-panel\s*\{/.test(stripped)).toBe(false)
            expect(/\.gf-pill-panel\b/.test(stripped)).toBe(false)
            expect(/\.gf-tooltip\b/.test(stripped)).toBe(false)
            expect(/\.gf-rephrase-card\b/.test(stripped)).toBe(false)
            expect(/\.gf-toast__action\b/.test(stripped)).toBe(false)
        })

        it('.gf-chip-source is defined exactly once (the stale hardcoded-px duplicate is gone)', () => {
            const matches = OVERLAY_CSS.match(/\.gf-chip-source\s*\{/g) ?? []
            expect(matches.length, '.gf-chip-source must be defined exactly once').toBe(1)
        })

        it('prefers-contrast/prefers-reduced-transparency blocks target the live .gf-rephrase class, not dead selectors', () => {
            const transparencyBlock = /@media \(prefers-reduced-transparency: reduce\)\s*\{([\s\S]*?)\n  \}/.exec(
                OVERLAY_CSS,
            )
            expect(transparencyBlock).not.toBeNull()
            expect(transparencyBlock![1]).toMatch(/\.gf-rephrase\b/)
            expect(transparencyBlock![1]).not.toMatch(/\.gf-rephrase-card/)

            const contrastBlocks = Array.from(
                OVERLAY_CSS.matchAll(/@media \(prefers-contrast: more\)\s*\{([\s\S]*?)\n  \}/g),
            )
            const hasRephrase = contrastBlocks.some((m) => /\.gf-rephrase\b/.test(m[1]!))
            const hasDeadRephraseCard = contrastBlocks.some((m) => /\.gf-rephrase-card/.test(m[1]!))
            expect(hasRephrase).toBe(true)
            expect(hasDeadRephraseCard).toBe(false)
        })
    })
})
