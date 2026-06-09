// The content-script pipeline. The pure orchestrator: ask the bridge for
// corrections, verify every byte span, attach a display category, and return
// renderable items. Kept free of DOM and network state so it can be unit-tested
// with stubbed dependencies. The wiring (event listeners, debouncing, overlay
// render) lives in entrypoints/content; this file knows nothing about the page.

import { deriveCategory, type CATEGORY_META } from '@/api/category'
import { verifyByteSpan } from '@/api/offset'
import type { BridgeSuggestion, Category, CorrectResponse } from '@/api/types'

/** A renderable correction item — one underline + one popover. */
export interface RenderableItem {
    /** UTF-16 code-unit offsets into the original `text`. */
    cuStart: number
    cuEnd: number
    /** Display category (resolves colour / texture / popover label). */
    category: Category
    /** Bridge-supplied message (e.g. explanation). May be empty. */
    message: string
    /** Replacement strings; index 0 is the primary. Always at least one. */
    replacements: string[]
    /** Original text the suggestion is replacing. */
    original: string
    /** The original UTF-8 byte span from the bridge (kept for re-check + signal). */
    byteSpan: { start: number; end: number }
    /** Bridge model tag (kept for signal context). */
    model: BridgeSuggestion['model']
    /** Bridge rule id (kept for signal context). */
    ruleId?: string
}

export interface RunCheckDeps {
    /** Call the bridge's /correct. Async; the orchestrator may debounce. */
    correct: (text: string) => Promise<CorrectResponse>
    /** Override for tests. Defaults to @/api/offset's verifyByteSpan. */
    verify?: (
        text: string,
        span: { start: number; end: number },
    ) => { start: number; end: number } | null
    /** Override for tests. Defaults to @/api/category's deriveCategory. */
    derive?: (s: BridgeSuggestion) => Category
}

export interface RunCheckResult {
    items: RenderableItem[]
    /** Suggestions that were dropped because their byte span failed verification. */
    dropped: number
}

/**
 * Run the check pipeline for a single text snapshot. Pure(ish) — no DOM, no
 * network unless the injected `correct` makes one. The caller (the content
 * orchestrator) decides when to call this; we just transform and return.
 *
 * Drops any suggestion whose byte span cannot be verified against the original
 * text (mid-codepoint, out of range, round-trip mismatch). A console.warn is
 * emitted for each drop — silently swallowing a broken span would hide a real
 * bridge bug.
 */
export async function runCheck(text: string, deps: RunCheckDeps): Promise<RunCheckResult> {
    const verify = deps.verify ?? verifyByteSpan
    const derive = deps.derive ?? ((s: BridgeSuggestion) => deriveCategory(s))
    const res = await deps.correct(text)

    const items: RenderableItem[] = []
    let dropped = 0
    for (const s of res.suggestions) {
        const cu = verify(text, s.span)
        if (!cu) {
            // oxlint-disable-next-line no-console
            console.warn('grammarforge: dropped suggestion with unverifiable byte span', s.span, s)
            dropped += 1
            continue
        }
        const replacements =
            s.replacements && s.replacements.length > 0 ? s.replacements : [s.replacement]
        const original = text.slice(cu.start, cu.end)
        items.push({
            cuStart: cu.start,
            cuEnd: cu.end,
            category: derive(s),
            message: s.message ?? '',
            replacements,
            original,
            byteSpan: { start: s.span.start, end: s.span.end },
            model: s.model,
            ruleId: s.ruleId,
        })
    }
    return { items, dropped }
}

/** Aggregate renderable items by category (used by the status pill summary). */
export function tallyByCategory(
    items: readonly RenderableItem[],
): Partial<Record<Category, number>> {
    const out: Partial<Record<Category, number>> = {}
    for (const it of items) {
        out[it.category] = (out[it.category] ?? 0) + 1
    }
    return out
}

/**
 * Decide whether a renderable item's span is still applicable to the LIVE
 * field text. Suggestions are computed against a text snapshot from a
 * debounced run; the user may have typed (or accepted/deleted) since. If the
 * slice at [cuStart, cuEnd] no longer matches the original substring the
 * suggestion was generated against, applying the fix would corrupt the text
 * (e.g. replacing a word that has since moved).
 *
 * Returns true when safe to apply, false when stale (the caller should hide
 * the overlay for that item and re-run the check).
 */
export function isSpanStillValid(
    text: string,
    item: Pick<RenderableItem, 'cuStart' | 'cuEnd' | 'original'>,
): boolean {
    if (item.cuStart < 0 || item.cuEnd < item.cuStart) return false
    if (item.cuStart > text.length || item.cuEnd > text.length) return false
    return text.slice(item.cuStart, item.cuEnd) === item.original
}

/** Re-export of the category metadata for renderers that want a single import. */
export type { CATEGORY_META }
