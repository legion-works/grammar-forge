import type { BridgeSuggestion, Category } from '@/api/types'

/**
 * Per-category display metadata.
 *
 * The single source of truth for GrammarForge's category palette is
 * `.opencode/specs/2026-06-15-client-redesign/handoff/scss/_tokens.scss`
 * (the `$gf-cat-*` Sass map). The two colour fields here play
 * distinct roles:
 *
 * - `badge` is the canonical token colour (`#ef4444` / `#eab308` /
 *   `#06b6d4` / `#8b5cf6` / `#6b7280`). The in-page overlay CSS
 *   (`overlay/styles.ts` → :host([data-gf-theme]) → `--gf-cat-*`)
 *   exposes the same values, and the popup/options page mirrors
 *   them via `popup.css` :root custom properties — keep all three
 *   in sync when the SCSS changes.
 *
 * - `tint` is a darker shade of the same hue, used in SOLID-bg
 *   contexts where the overlay's translucent `color-mix(in srgb,
 *   var(--gf-cat-X) 22%, transparent)` would not composite
 *   correctly. The popup summary swatches + legend swatches
 *   (`popup/App.tsx` → `style={{ background: CATEGORY_META[c].tint }}`)
 *   read from this field. The overlay itself does NOT use `tint` —
 *   it always resolves the badge colour through CSS `color-mix` so
 *   the 22% alpha tint is theme-aware (light vs dark glass swap the
 *   underlying surface, not the marker hue).
 *
 * The `unknown` category intentionally stays neutral grey — there
 * is no SCSS token for it; the bridge never emits it as a wire
 * `category`, it only appears as the fallback when
 * `deriveCategory()` cannot resolve from `model` either.
 */
export const CATEGORY_META: Record<
    Category,
    {
        label: string
        badge: string
        tint: string
        priority: number
    }
> = {
    spelling: {
        label: 'Spelling',
        badge: '#ef4444',
        tint: '#dc2626',
        priority: 5,
    },
    grammar: {
        label: 'Grammar',
        badge: '#eab308',
        tint: '#ca8a04',
        priority: 4,
    },
    punctuation: {
        label: 'Punctuation',
        badge: '#06b6d4',
        tint: '#0891b2',
        priority: 3,
    },
    style: {
        label: 'Style',
        badge: '#8b5cf6',
        tint: '#7c3aed',
        priority: 2,
    },
    typography: {
        label: 'Typography',
        badge: '#6b7280',
        tint: '#6b7280',
        priority: 1,
    },
    unknown: {
        label: 'Issue',
        badge: '#9ca3af',
        tint: '#9ca3af',
        priority: 0,
    },
}

const VALID: ReadonlySet<string> = new Set(Object.keys(CATEGORY_META))

/**
 * Resolve a suggestion's display category. Prefers the bridge wire `category`
 * when present and recognised; otherwise derives from `model` (+ ruleId). The
 * wire has NO LintKind field, so a Harper suggestion without a wire category
 * cannot be distinguished from grammar client-side — which is exactly why the
 * bridge (WS-A) emits `category`.
 */
export function deriveCategory(
    s: Pick<BridgeSuggestion, 'category' | 'model' | 'ruleId' | 'span' | 'replacement'>,
): Category {
    if (s.category && VALID.has(s.category)) return s.category as Category
    switch (s.model) {
        case 'gector':
            return 'grammar'
        case 'llm':
            return 'grammar'
        case 'harper':
            return 'grammar'
        case 'lt_rule':
            return 'unknown'
        default:
            return 'unknown'
    }
}
