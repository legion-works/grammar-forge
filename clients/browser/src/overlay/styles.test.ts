// @vitest-environment jsdom
// CSS-string assertions for OVERLAY_CSS. Visual layout can't be jsdom-tested
// (no real layout engine), but the load-bearing CSS invariants — the .gf-orb
// 60×60 sizing, the .gf-card Popover-API override, the .gf-panel-aside fixed
// positioning, the .gf-u is-on tint — CAN be asserted against the string.
// These tests would have caught all three W2 live bugs.
import { describe, expect, it } from 'vitest'
import { OVERLAY_CSS } from '@/overlay/styles'

describe('OVERLAY_CSS (W2 design system shadow-root CSS)', () => {
    describe('.gf-orb (score orb)', () => {
        it('constrains the orb to 60×60 (W1 sizing carried into W2)', () => {
            // Bug-fix: the W1 .gf-orb sets width: 60px; height: 60px. The W2
            // redesign added a second .gf-orb rule (border-radius, hover
            // scale) but did NOT re-constrain the size. The 60×60 must stay
            // — the W2 .gf-orb rule is additive only. If someone removes the
            // W1 width/height, the orb falls back to its intrinsic size
            // (a 60px SVG + padding = ~76px) and renders HUGE + clipped.
            const rule = /\.gf-orb\s*\{[^}]*width:\s*60px[^}]*height:\s*60px/s.exec(OVERLAY_CSS)
            expect(rule, 'W1 .gf-orb must set width:60px + height:60px').not.toBeNull()
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
            // The panel.ts positionPanel() sets style.left + style.top.
            // If the panel were position: absolute (or unset), the panel
            // would anchor to its containing block (the shadow host at
            // 0,0 of the viewport — same result, but fixed is the
            // honest declaration). The bug-fix that motivated this test
            // was the .gf-card omission; the .gf-panel-aside has always
            // been fixed, so this is a regression guard.
            const rule = /\.gf-panel-aside\s*\{[^}]*position:\s*fixed/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-panel-aside must be position: fixed').not.toBeNull()
        })

        it('constrains the width to 344px (W2b design)', () => {
            const rule = /\.gf-panel-aside\s*\{[^}]*width:\s*344px/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-panel-aside must set width: 344px').not.toBeNull()
        })
    })

    describe('.gf-u (per-span highlight)', () => {
        it('renders a wavy underline via border-bottom (works on empty divs)', () => {
            // text-decoration: underline wavy does NOT render on a div with
            // no text content — the highlight nodes are empty <div>s. The
            // W1 .gf-u used border-bottom: 1.7px wavy which renders the
            // underline regardless of content. Both rules co-exist (W1
            // border-bottom for the visual, W2 text-decoration for future
            // text-span use). This test guards the W1 border-bottom.
            const rule = /\.gf-u\s*\{[^}]*border-bottom:\s*1\.7px wavy/s.exec(OVERLAY_CSS)
            expect(rule, '.gf-u must set border-bottom: 1.7px wavy').not.toBeNull()
        })

        it('drives a 22% tint via .is-on (per-category + generic)', () => {
            // The W1 .gf-u.is-on + W2 .gf-u--<cat>.is-on both produce a
            // 22% tinted background on hover / focus. If either rule is
            // removed, the hover tint breaks.
            const generic = /\.gf-u\.is-on\s*\{[^}]*background:/s.exec(OVERLAY_CSS)
            expect(generic, '.gf-u.is-on must set a background tint').not.toBeNull()
            const perCat = /\.gf-u--spelling\.is-on\s*\{[^}]*background:/s.exec(OVERLAY_CSS)
            expect(perCat, '.gf-u--spelling.is-on must set a background tint').not.toBeNull()
        })
    })
})
