// Pure helpers for the correction card (`popover.ts`). Extracted so the
// nav-index math, confidence→band mapping, and source-chip label
// selection are unit-testable without a shadow root. None of these touch
// the DOM — they only translate typed inputs into typed outputs, so they
// stay cheap to import from the imperative popover module.

import type { BridgeSuggestion } from '@/api/types'

/** Confidence band label rendered next to the confidence bar. */
export type ConfidenceBand = 'high' | 'medium' | 'low'

/** The CSS class suffix appended to `.gf-card__conf-color-<band>` by the
 *  stylesheet. Single source of truth so tests + renderer agree. */
export const CONFIDENCE_BAND_CLASS: Record<ConfidenceBand, string> = {
    high: 'high',
    medium: 'medium',
    low: 'low',
}

/** Threshold for the medium/low boundary, matching the design tokens in
 *  `handoff/scss/_tokens.scss` ($gf-conf-*). Centralised so the test +
 *  renderer + future SCSS cannot drift. */
export const CONFIDENCE_THRESHOLDS = {
    high: 0.9,
    medium: 0.75,
} as const

/** Map a 0..1 confidence to a card band label. Undefined = LLM items the
 *  bridge did not score — treat as high (the AI chip already says "✨ AI",
 *  so the bar is decorative; we pick a colour that doesn't read as "low"). */
export function confidenceBand(confidence: number | undefined): ConfidenceBand {
    if (confidence === undefined) return 'high'
    if (confidence >= CONFIDENCE_THRESHOLDS.high) return 'high'
    if (confidence >= CONFIDENCE_THRESHOLDS.medium) return 'medium'
    return 'low'
}

/** The 0..100 number rendered in the bar's `width:` inline style, rounded
 *  to one decimal. Clamped to [0, 100]. Undefined → 100 (see confidenceBand). */
export function confidenceBarWidth(confidence: number | undefined): number {
    if (confidence === undefined) return 100
    const pct = Math.max(0, Math.min(100, Math.round(confidence * 1000) / 10))
    return pct
}

/** Variant + label for the model source chip in the card head. */
export type SourceChipVariant = 'fast' | 'ai'

export interface SourceChip {
    /** The display text — may include a `<span class="gf-chip-source__hint">`
     *  fragment for the "· instant" hint, which the CSS dims. */
    text: string
    /** Selects `.gf-chip-source` (fast) vs `.gf-chip-source--ai` (LLM). */
    variant: SourceChipVariant
}

/** Decide which source chip to render for a given model.
 *  - 'harper' → "Harper · instant"
 *  - 'gector' → "GECToR · instant"
 *  - 'llm' | 'lt_rule' | undefined → "✨ AI" (LLM-equivalent) */
export function sourceChipLabel(model: BridgeSuggestion['model'] | undefined): SourceChip {
    switch (model) {
        case 'harper':
            return {
                text: 'Harper<span class="gf-chip-source__hint"> · instant</span>',
                variant: 'fast',
            }
        case 'gector':
            return {
                text: 'GECToR<span class="gf-chip-source__hint"> · instant</span>',
                variant: 'fast',
            }
        case 'llm':
        case 'lt_rule':
        default:
            return { text: '✨ AI', variant: 'ai' }
    }
}

export interface NavPosition {
    /** 1-based current issue index, always in [1, total]. */
    current: number
    /** Total open issues, always >= 1 (the function returns null otherwise). */
    total: number
}

/** Pin `navIndex` to the valid 1-based range. Returns null when there are
 *  no open issues — the caller should hide the nav row entirely. */
export function clampNavIndex(
    navIndex: number | undefined,
    navTotal: number | undefined,
): NavPosition | null {
    const total = Math.max(0, Math.floor(navTotal ?? 0))
    if (total <= 0) return null
    const idx = Math.floor(navIndex ?? 1)
    const current = Math.max(1, Math.min(total, idx))
    return { current, total }
}

/** Format the "N of M" label rendered in `.gf-card__nav-count`. */
export function navLabel(current: number, total: number): string {
    return `${current} of ${total}`
}
