// Pure-function view-model helpers shared by the W2 surfaces (panel, orb,
// goals, stats) across both clients. NO DOM, NO network — the orchestrator
// passes in items + goals + phase and reads back the derived values.
//
// Penalty weights, band cut-offs, ring geometry, and insight math come from
// the REFERENCE DC `GrammarForge Assistant.dc.html` (lines 252-258, 486-490,
// 192) — the user-facing mock is the single source of truth. The plan + SCSS
// tokens are derivations of the DC and are not authoritative for the score
// math, band colours, or ring geometry used at render time.

import type { Band, Goals, Phase } from '@/api/types'
import type { RenderableItem } from '@/lib/pipeline'

/** Penalty deducted from the 100-point score per open issue, by category.
 *  Spelling 5, grammar 4, punctuation 3, style 2, typography 1. Unknown /
 *  future categories fall back to 1. (Reference DC lines 252-258.) */
const PENALTY: Record<string, number> = {
    spelling: 5,
    grammar: 4,
    punctuation: 3,
    style: 2,
    typography: 1,
    unknown: 1,
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
    const penalty = visible.reduce((acc, it) => acc + (PENALTY[it.category] ?? 1), 0)
    return Math.max(0, 100 - penalty)
}

/** Band label from score. Inclusive lower bounds: ≥90 excellent, ≥78 good,
 *  ≥60 fair, else needs-work. (Reference DC; matches `flows.md §0`.) */
export function scoreBand(score: number): Band {
    if (score >= 90) return 'excellent'
    if (score >= 78) return 'good'
    if (score >= 60) return 'fair'
    return 'needs-work'
}

/** SVG arc dashoffset for the score ring (r=24.5, circumference = 2πr ≈ 153.9).
 *  Score 100 → 0 (full ring); score 0 → 153.9 (no ring). (Reference DC line 486.) */
export function arcOffset(score: number): number {
    return 153.9 * (1 - score / 100)
}

/** Stroke colour per band — matches the reference DC score ring palette
 *  (line 486). Distinct from the SCSS `$gf-band-*` tokens, which are
 *  decorative only — the math here drives what users see on the orb. */
export const BAND_COLOR: Record<Band, string> = {
    excellent: '#16a34a',
    good: '#0891b2',
    fair: '#d97706',
    'needs-work': '#dc2626',
}

/** Pure derivation of what the per-field score orb should render, given the
 *  current streaming phase + visible count + (optional) score. CONSUMED by
 *  the browser `status-button.ts` and the Vencord equivalent; the orchestrator
 *  is the only caller that should compute `score` from items — the orb itself
 *  is a thin consumer of the helpers above (arcOffset / scoreBand / BAND_COLOR).
 *
 *  The four center-glyph states (per flows.md §6 + plan W2-1 / W1-6):
 *  - `power`  — site-paused (disabled wins over everything; the user sees a
 *               single, unambiguous affordance).
 *  - `pip`    — `phase === 'fast'` AND there are visible suggestions (the LLM
 *               is still refining; the user sees motion + sparkle, not a stale
 *               number that will jump when 'done' arrives).
 *  - `clean`  — `openCount === 0` (all clear; renders ✓ in the center).
 *  - `count`  — `openCount > 0` and the phase has settled (default).
 *
 *  Score / band fallbacks: an undefined `score` (the orchestrator has not run
 *  a check yet) defaults to 100 — the ring renders FULL + green and the orb
 *  reads as "nothing to flag." `band` short-circuits the score→band lookup
 *  when the caller already has it (saves one map access per render). */
export type OrbCenter = 'count' | 'clean' | 'power' | 'pip'

export interface OrbStateInput {
    /** 0-100 writing score (see `computeScore`). Undefined = not yet computed. */
    score?: number
    /** Pre-computed band (skips `scoreBand()` if provided). */
    band?: Band
    /** Number of open, visible suggestions driving the center glyph. */
    openCount: number
    /** Streaming phase. 'fast' swaps the count for the AI pip (see above). */
    phase: Phase
    /** Site-paused state — power glyph always wins. */
    disabled: boolean
}

export interface OrbState {
    /** Which center glyph to render. */
    center: OrbCenter
    /** The number to render in the center when `center === 'count'`. */
    count: number
    /** SVG `stroke-dashoffset` for the score ring (r=24.5, circ 153.9). */
    ringOffset: number
    /** SVG `stroke` for the score ring — matches the score's band. */
    ringColor: string
}

export function orbState(input: OrbStateInput): OrbState {
    const { score, band, openCount, phase, disabled } = input
    const effectiveScore = score ?? 100
    const effectiveBand = band ?? scoreBand(effectiveScore)
    const ringColor = BAND_COLOR[effectiveBand]
    const ringOffset = arcOffset(effectiveScore)
    if (disabled) return { center: 'power', count: 0, ringOffset, ringColor }
    if (phase === 'fast' && openCount > 0) return { center: 'pip', count: 0, ringOffset, ringColor }
    if (openCount === 0) return { center: 'clean', count: 0, ringOffset, ringColor }
    return { center: 'count', count: openCount, ringOffset, ringColor }
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

/** Confidence → label + stroke colour for the correction-card confidence
 *  bar. `>= 0.9` → 'High' green, `>= 0.75` → 'Medium' amber, else → 'Low'
 *  slate. (Reference DC line 192 — the confbar's "High/Medium/Low" pill
 *  + bar fill colour.) */
export type ConfidenceLabel = 'High' | 'Medium' | 'Low'
export function confLabel(confidence: number | undefined): ConfidenceLabel {
    const c = confidence ?? 0
    if (c >= 0.9) return 'High'
    if (c >= 0.75) return 'Medium'
    return 'Low'
}
export const CONF_COLOR: Record<ConfidenceLabel, string> = {
    High: '#16a34a',
    Medium: '#d97706',
    Low: '#64748b',
}

/** Insight numbers for the panel's stat row. The reference DC renders
 *  these as a static "Words / Read time / Sentences / Readability" strip
 *  populated from the field's text + suggestion state.
 *
 *  Math (reference DC lines 192/486/490 — verbatim, no rounding tricks):
 *  - `words`  = text.trim() ? text.trim().split(/\s+/).length : 0
 *  - `sents`  = Math.max(1, (text.match(/[.!?]+/g) || []).length)
 *  - `wps`    = words / sents
 *  - `grade`  = wps < 13 ? 6 : wps < 17 ? 8 : 11  (US school grade)
 *  - `readLabel` = wps < 17 ? 'Clear' : 'Dense'
 *  - `readSecs`  = Math.max(1, Math.round(words / 200 * 60))  (200 wpm)
 *
 *  Tone row ('Confident' / 'Warm') is a STATIC decorative tag in the
 *  reference — it is NOT computed and does not call /tone. The orchestrator
 *  is free to swap the static string later (W3+ wiring). */
export interface FieldInsights {
    words: number
    sentences: number
    wordsPerSentence: number
    grade: 6 | 8 | 11
    readLabel: 'Clear' | 'Dense'
    readSecs: number
}
export function makeInsights(text: string): FieldInsights {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    const sents = Math.max(1, (text.match(/[.!?]+/g) || []).length)
    const wps = words / sents
    const grade: 6 | 8 | 11 = wps < 13 ? 6 : wps < 17 ? 8 : 11
    const readLabel: 'Clear' | 'Dense' = wps < 17 ? 'Clear' : 'Dense'
    const readSecs = Math.max(1, Math.round((words / 200) * 60))
    return { words, sentences: sents, wordsPerSentence: wps, grade, readLabel, readSecs }
}
