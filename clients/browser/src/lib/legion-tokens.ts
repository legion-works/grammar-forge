// Single source of truth for GrammarForge's "Legion Works" design-system
// color constants (see handoff/scss/_tokens.scss + handoff/README.md for
// the original design-system definition this consolidates).
//
// Before this module existed, the same hex literals were hand-copied
// across:
//   - src/api/category.ts        (CATEGORY_META badge/tint)
//   - src/overlay/panel-model.ts (CATEGORY_DOT)
//   - src/overlay/stats-view.ts  (CATEGORY_DOT)
//   - src/lib/view-model.ts      (BAND_COLOR, CONF_COLOR)
//   - src/overlay/styles.ts      (both :host([data-gf-theme]) token blocks)
//   - src/entrypoints/popup/popup.css (:root custom properties — CSS can't
//     import TS, so it keeps its own literals, checked against this module
//     by popup-css-palette-sync.test.ts)
//   - clients/vencord/src/legion-palette.ts (re-exports this module's dark
//     values under its historical names)
//
// This was a PURE CONSOLIDATION — no color value changed. Where two
// locations previously disagreed (view-model.ts's CONF_COLOR.Low used to
// be #64748b vs styles.ts's dark-theme --gf-conf-low #828bb8 — see the
// P1-10 note in view-model.test.ts), the styles.ts DARK-THEME value was
// already the one kept pre-consolidation; this module preserves that
// choice and is now the only place it's written down.
//
// Every other TS consumer imports its constants from here. overlay/styles.ts
// interpolates them into its CSS-in-JS template (the token-definition
// blocks only — the rest of that file is untouched hand-written CSS).

import type { Band, Category } from '@/api/types'

/** Per-category badge (saturated marker colour — underlines, dots, chips)
 *  + tint (a darker shade of the same hue, used in solid-bg contexts like
 *  the popup's summary/legend swatches, where the overlay's translucent
 *  `color-mix(... 22%, transparent)` treatment wouldn't composite
 *  correctly). Identical in the light and dark theme blocks of
 *  overlay/styles.ts (which only defines `badge`, as `--gf-cat-*`).
 *
 *  `unknown` has no dedicated `--gf-cat-*` CSS token (the bridge never
 *  emits it as a wire category — see api/category.ts's deriveCategory) —
 *  it stays a plain neutral-grey fallback. */
export const CATEGORY_COLOR: Record<Category, { badge: string; tint: string }> = {
    spelling: { badge: '#ef4444', tint: '#dc2626' },
    grammar: { badge: '#eab308', tint: '#ca8a04' },
    punctuation: { badge: '#06b6d4', tint: '#0891b2' },
    style: { badge: '#8b5cf6', tint: '#7c3aed' },
    typography: { badge: '#6b7280', tint: '#6b7280' },
    unknown: { badge: '#9ca3af', tint: '#9ca3af' },
}

/** Score-band stroke colour (the orb ring, the panel ring, `--gf-band-*`).
 *  Identical across the light and dark theme blocks. */
export const BAND_COLOR: Record<Band, string> = {
    excellent: '#16a34a',
    good: '#0891b2',
    fair: '#d97706',
    'needs-work': '#dc2626',
}

/** Confidence-bar colour. High/Medium are theme-invariant; Low differs
 *  between themes (`--gf-conf-low`: dark `#828bb8`, light `#565f89`). The
 *  correction-card confidence bar (lib/view-model.ts's `CONF_COLOR`)
 *  always renders inside the overlay's dark glass surface, so it takes
 *  the DARK value — `CONF_LOW_LIGHT` is exported separately for the
 *  light-theme CSS token block / sync tests. */
export const CONF_COLOR = {
    high: '#16a34a',
    medium: '#d97706',
    low: '#828bb8',
} as const

export const CONF_LOW_LIGHT = '#565f89'

/** Core Legion accent/ink/purple/success values, per theme (see
 *  overlay/styles.ts's `:host([data-gf-theme="..."])` blocks — the
 *  "Tokyo Day" / "Tokyo Night" palettes). Dark theme's cyan is bright
 *  enough that it needs DARK ink text on any accent-filled surface
 *  (never white — see handoff/LOGO.md); light theme's darker, more
 *  saturated cyan is the opposite (white ink). */
export const LEGION = {
    dark: {
        accent: '#86e1fc',
        accentHover: '#a9ebff',
        accentInk: '#0c1622',
        purple: '#c099ff', // --gf-ai-violet
        purpleSoft: '#a87ff0', // --gf-ai-violet-soft
        success: '#c3e88d', // --gf-success (Tokyo green, all-clear)
    },
    light: {
        accent: '#2f7d9c',
        accentHover: '#245f78',
        accentInk: '#ffffff',
        purple: '#a87ff0',
        purpleSoft: '#8347d9',
        success: '#a8d472',
    },
} as const
