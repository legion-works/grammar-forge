import type { BridgeSuggestion, Category } from '@/api/types'
import { CATEGORY_COLOR } from '@/lib/legion-tokens'

/**
 * Per-category display metadata.
 *
 * The single source of truth for GrammarForge's category COLOURS is
 * `lib/legion-tokens.ts` (`CATEGORY_COLOR` — a consolidation of the
 * Legion Works `--cat-*` design tokens, originally
 * `handoff/scss/_tokens.scss`'s `$gf-cat-*` Sass map — see
 * handoff/README.md). `label` and `priority` are display-only metadata
 * that live here, merged with the shared colour tokens. The two colour
 * fields play distinct roles:
 *
 * - `badge` is the canonical token colour (`#ef4444` / `#eab308` /
 *   `#06b6d4` / `#8b5cf6` / `#6b7280`). The in-page overlay CSS
 *   (`overlay/styles.ts` → :host([data-gf-theme]) → `--gf-cat-*`)
 *   interpolates the same `CATEGORY_COLOR` constants, and the
 *   popup/options page mirrors them via `popup.css` :root custom
 *   properties (CSS can't import TS — checked by
 *   popup-css-palette-sync.test.ts instead).
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
 * is no CSS token for it; the bridge never emits it as a wire
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
    spelling: { label: 'Spelling', priority: 5, ...CATEGORY_COLOR.spelling },
    grammar: { label: 'Grammar', priority: 4, ...CATEGORY_COLOR.grammar },
    punctuation: { label: 'Punctuation', priority: 3, ...CATEGORY_COLOR.punctuation },
    style: { label: 'Style', priority: 2, ...CATEGORY_COLOR.style },
    typography: { label: 'Typography', priority: 1, ...CATEGORY_COLOR.typography },
    unknown: { label: 'Issue', priority: 0, ...CATEGORY_COLOR.unknown },
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
