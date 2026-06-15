// Pure-function view-model helpers shared by the W2 surfaces (panel, orb,
// goals, stats) across both clients. NO DOM, NO network — the orchestrator
// passes in items + goals + phase and reads back the derived values.
//
// Penalty weights and band cut-offs come from the redesign plan and the
// `_tokens.scss` / `flows.md` spec. The `BAND_COLOR` map is the SCSS source
// of truth for the arc stroke; the *score math* (penalty sum, band cut-offs)
// is independent of the visual tokens and lives here.

import type { Band, Goals, Phase } from '@/api/types'
import type { RenderableItem } from '@/lib/pipeline'

/** Penalty deducted from the 100-point score per open issue, by category.
 *  Spelling costs the most (8), typography the least (2). Unknown / future
 *  categories fall back to 2. The plan's exact weights — see the §Penalty
 *  block in `.opencode/plans/2026-06-15-redesign-client-surfaces.md`. */
const PENALTY: Record<string, number> = {
    spelling: 8,
    grammar: 6,
    punctuation: 4,
    style: 3,
    typography: 2,
    unknown: 2,
}

/** Items that count toward the score AND appear in the UI.
 *  - status must be 'open' (accepted/dismissed items are filtered out).
 *  - LLM items only surface after `phase === 'done'` (the streaming fast
 *    frame is local-only — Harper + GECToR + cache).
 *  - `formality === 'informal'` mutes style suggestions (their underline
 *    vanishes; the muted count is exposed separately via `mutedStyleCount`
 *    so the panel can show the "N style suggestions muted" note). */
export function visibleItems(
    items: readonly RenderableItem[],
    phase: Phase,
    goals: Goals,
): RenderableItem[] {
    return items.filter((it) => {
        if (it.status !== 'open') return false
        if (it.model === 'llm' && phase === 'fast') return false
        if (goals.formality === 'informal' && it.category === 'style') return false
        return true
    })
}

/** Score 0-100 over the visible items. `Math.max(0, …)` floors at zero — a
 *  catastrophically-broken text never produces a negative score (the panel
 *  ring's `arcOffset` would render a > 1.0 multiplier). */
export function computeScore(visible: readonly RenderableItem[]): number {
    const penalty = visible.reduce((acc, it) => acc + (PENALTY[it.category] ?? 2), 0)
    return Math.max(0, 100 - penalty)
}

/** Band label from score. Inclusive lower bounds: ≥90 excellent, ≥78 good,
 *  ≥60 fair, else needs-work. Matches `flows.md §0` and the panel ring
 *  colour (`BAND_COLOR`). */
export function scoreBand(score: number): Band {
    if (score >= 90) return 'excellent'
    if (score >= 78) return 'good'
    if (score >= 60) return 'fair'
    return 'needs-work'
}

/** SVG arc dashoffset for a 24-radius circle (circumference = 2πr ≈ 150.8).
 *  Score 100 → 0 (full ring); score 0 → 150.8 (no ring). */
export function arcOffset(score: number): number {
    return 150.8 * (1 - score / 100)
}

/** Stroke colour per band — matches the SCSS `$gf-band-*` tokens (plan
 *  specifies these hex values verbatim; verified against the
 *  `_tokens.scss` palette at design-system time). */
export const BAND_COLOR: Record<Band, string> = {
    excellent: '#16a34a',
    good: '#2563eb',
    fair: '#d97706',
    'needs-work': '#ef4444',
}

/** High-confidence items (confidence ≥ 0.90). The panel's "Accept
 *  high-confidence only" button is gated on `0 < highConf.length <
 *  visible.length` by the caller — this helper just returns the matching
 *  items, never lies about whether the button should render. Items with
 *  `confidence === undefined` (LLM suggestions the bridge did not score)
 *  are treated as 0 — never high. */
export function highConfidenceItems(visible: readonly RenderableItem[]): RenderableItem[] {
    return visible.filter((it) => (it.confidence ?? 0) >= 0.9)
}

/** Muted style count for the "N style suggestions muted by your goals" note.
 *  Returns 0 unless `formality === 'informal'`. Counts only OPEN style
 *  items (a dismissed style item is not "muted by goals" — the user
 *  already dealt with it). */
export function mutedStyleCount(items: readonly RenderableItem[], goals: Goals): number {
    if (goals.formality !== 'informal') return 0
    return items.filter((it) => it.status === 'open' && it.category === 'style').length
}

/** Default rephrase tone from the user's `formality` setting. The rephrase
 *  card lets the user override this per-request. */
export function defaultToneFromGoals(goals: Goals): 'neutral' | 'formal' | 'casual' {
    if (goals.formality === 'formal') return 'formal'
    if (goals.formality === 'informal') return 'casual'
    return 'neutral'
}
