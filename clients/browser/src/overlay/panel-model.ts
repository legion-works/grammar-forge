// Pure-function view-model assembly for the W2b review panel. Consumes
// the per-field view-model helpers (visibleItems, computeScore, scoreBand,
// makeInsights, highConfidenceItems, mutedStyleCount) and returns a flat
// object the DOM render reads. NO DOM, NO network — the imperative
// `panel.ts` calls this once per render, then walks the model to mount
// children. Unit-testable in isolation (no jsdom, no shadow root).
//
// Visual source of truth: the reference DC (lines 730-829) — the panel
// reuses the same score/insights/groups math the W2 orb + goals popover
// already share. This file is the SINGLE place the panel's per-section
// gates (showHighConfButton, showMutedNote, showStreamingBanner) live, so
// DOM tests only need to assert on the rendered structure.

import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'
import {
    computeScore,
    highConfidenceItems,
    makeInsights,
    mutedStyleCount,
    scoreBand,
    visibleItems,
} from '@/lib/view-model'
import type { RenderableItem } from '@/lib/pipeline'
import type { Band, Goals, Phase } from '@/api/types'

/** Stable ordering for the per-category groups (matches the reference DC
 *  canonical order; "unknown" lands last so a future category surprise
 *  doesn't reshuffle the visible list). */
const CATEGORY_ORDER: readonly Category[] = [
    'spelling',
    'grammar',
    'punctuation',
    'style',
    'typography',
    'unknown',
] as const

/** Per-category dot color — same palette the underlines + popover already
 *  use. Kept here as a string fallback (the design-system tokens resolve
 *  via CSS variables; this is the inline-style default that renders before
 *  CSS variables are scoped). */
const CATEGORY_DOT: Record<Category, string> = {
    spelling: '#ef4444',
    grammar: '#eab308',
    punctuation: '#06b6d4',
    style: '#8b5cf6',
    typography: '#6b7280',
    unknown: '#9ca3af',
}

const RING_RADIUS = 24.5
const RING_CIRCUMFERENCE = 153.9

export interface PanelGroupItem {
    item: RenderableItem
    dot: string
    /** Label used by the chip — `Harper · instant`, `✨ AI`, etc. The full
     *  chip is rendered by the DOM; this is the text fragment. */
    chipLabel: string
}

export interface PanelGroup {
    category: Category
    label: string
    dot: string
    items: PanelGroupItem[]
    /** `acceptCategory` callback index — the panel DOM calls
     *  `onAcceptCategory(group.category)` when the user clicks the per-group
     *  Accept-all chip. The category is the only field needed; the model
     *  carries it so the DOM doesn't re-derive it from the items. */
}

export interface PanelModel {
    /** 0-100 score, derived from `visible` via `computeScore`. */
    score: number
    /** Band label derived from `score` (also passed as the ring's stroke). */
    band: Band
    /** SVG ring stroke color — band-keyed, matches the orb ring. */
    ringColor: string
    /** SVG ring stroke-dashoffset (0 = full, 153.9 = empty). */
    ringOffset: number
    /** SVG ring stroke-dasharray (constant 153.9 for the r=24.5 ring). */
    ringDasharray: number
    /** SVG ring radius (constant 24.5). */
    ringRadius: number
    /** Tone tag string (static decorative; the DC hardcodes 'Confident' +
     *  'Warm' — no /tone call yet, just text). */
    toneLabel: string
    /** Readability + grade label ("Clear · Gr 8"). */
    readabilityLabel: string
    /** Word count. */
    words: number
    /** Read-time in seconds (max(1, round(words/200*60))). */
    readSecs: number
    /** Visible (open + phase-aware + goal-muted) items, in input order. */
    visible: RenderableItem[]
    /** Number of visible items driving the "N suggestions as you type" line. */
    suggestionCount: number
    /** Per-category groups (one section per category that has ≥ 1 visible
     *  item, in canonical CATEGORY_ORDER). */
    groups: PanelGroup[]
    /** High-confidence count (always returned; the visibility of the
     *  button is the caller's job — see `showHighConfButton`). */
    highConfCount: number
    /** `true` ONLY when `0 < highConfCount < suggestionCount` — the
     *  single source of truth for the "Accept N high-confidence only"
     *  button's visibility (matches flows.md §5 + reference DC line 793). */
    showHighConfButton: boolean
    /** Count of style items muted by the user's goals (≥ 0; `> 0` is the
     *  trigger for the dashed "N style suggestions muted by your goals"
     *  note). */
    mutedStyleCount: number
    /** `true` when the muted-note should render (= mutedStyleCount > 0). */
    showMutedNote: boolean
    /** `true` when the streaming banner should render (= phase === 'fast'). */
    showStreamingBanner: boolean
}

/** Group `items` by category, preserving the canonical category order.
 *  Unknown / future categories land last (the renderer hides empty groups
 *  — see `buildPanelModel`). The per-item `chipLabel` is the text-only
 *  fragment ("Harper", "✨ AI", "GECToR"); the DOM adds the "· instant"
 *  suffix for fast-path models. */
export function groupItemsByCategory(items: readonly RenderableItem[]): PanelGroup[] {
    const byCat = new Map<Category, RenderableItem[]>()
    for (const it of items) {
        let bucket = byCat.get(it.category)
        if (!bucket) {
            bucket = []
            byCat.set(it.category, bucket)
        }
        bucket.push(it)
    }
    const groups: PanelGroup[] = []
    for (const cat of CATEGORY_ORDER) {
        const bucket = byCat.get(cat)
        if (!bucket || bucket.length === 0) continue
        const meta = CATEGORY_META[cat]
        groups.push({
            category: cat,
            label: meta.label,
            dot: CATEGORY_DOT[cat],
            items: bucket.map((it) => ({
                item: it,
                dot: CATEGORY_DOT[it.category],
                chipLabel: sourceChipLabelFor(it),
            })),
        })
    }
    return groups
}

function sourceChipLabelFor(item: RenderableItem): string {
    if (item.model === 'llm') return '✨ AI'
    if (item.model === 'lt_rule') return 'rule'
    if (item.model === 'gector') return 'GECToR'
    return 'Harper'
}

/** Assemble the panel view-model from a snapshot of the field state. The
 *  caller passes the RAW (unfiltered) items list — this helper runs
 *  `visibleItems` internally so the panel and the score agree. `text` is
 *  the full field text (for `makeInsights`); `goals` drives the visible
 *  filter + the muted note; `phase` drives the LLM item visibility + the
 *  streaming banner gate. */
export function buildPanelModel(input: {
    items: readonly RenderableItem[]
    text: string
    goals: Goals
    phase: Phase
}): PanelModel {
    const { items, text, goals, phase } = input
    const visible = visibleItems(items, phase, goals)
    const score = computeScore(visible)
    const band = scoreBand(score)
    const insights = makeInsights(text)
    const hc = highConfidenceItems(visible)
    const muted = mutedStyleCount(items, goals)
    return {
        score,
        band,
        // band→color is a presentation concern of the existing view-model
        // (BAND_COLOR); inline this to keep panel-model free of an extra
        // import (the panel tests assert on the exact string match).
        ringColor: bandColorFor(band),
        ringOffset: 153.9 * (1 - score / 100),
        ringDasharray: RING_CIRCUMFERENCE,
        ringRadius: RING_RADIUS,
        toneLabel: '● Confident  ● Warm',
        readabilityLabel: `${insights.readLabel} · Gr ${String(insights.grade)}`,
        words: insights.words,
        readSecs: insights.readSecs,
        visible,
        suggestionCount: visible.length,
        groups: groupItemsByCategory(visible),
        highConfCount: hc.length,
        showHighConfButton: hc.length > 0 && hc.length < visible.length,
        mutedStyleCount: muted,
        showMutedNote: muted > 0,
        showStreamingBanner: phase === 'fast',
    }
}

// Inline copy of the BAND_COLOR palette to keep this file's imports
// surface small (the panel tests don't need to import view-model just to
// compare strings). MUST stay in lock-step with view-model.BAND_COLOR —
// the unit tests assert the exact match in both directions.
const BAND_COLOR: Record<Band, string> = {
    excellent: '#16a34a',
    good: '#0891b2',
    fair: '#d97706',
    'needs-work': '#dc2626',
}

function bandColorFor(band: Band): string {
    return BAND_COLOR[band]
}
