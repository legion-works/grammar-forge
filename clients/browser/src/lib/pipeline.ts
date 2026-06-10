// The content-script pipeline. The pure orchestrator: ask the bridge for
// corrections, verify every byte span, attach a display category, and return
// renderable items. Kept free of DOM and network state so it can be unit-tested
// with stubbed dependencies. The wiring (event listeners, debouncing, overlay
// render) lives in entrypoints/content; this file knows nothing about the page.

import { deriveCategory, type CATEGORY_META } from '@/api/category'
import { verifyByteSpan } from '@/api/offset'
import { wordLevelDiff } from '@/lib/word-diff'
import type { BridgeSuggestion, Category, CorrectResponse } from '@/api/types'

/** A renderable correction item — one highlight + one popover. */
export interface RenderableItem {
    /** Correction-log row id from the bridge (set once the bridge persisted the
     *  correction). Sent back with the accept/reject/ignore signal so the bridge
     *  can attribute it. Undefined when the bridge did not log this suggestion. */
    id?: number
    /** UTF-16 code-unit offsets of the minimal edit into the original `text`.
     *  Used to APPLY the fix (applyFix) and to validate staleness — NOT for the
     *  highlight rect (an insertion is zero-width here). */
    cuStart: number
    cuEnd: number
    /** Code-unit range to HIGHLIGHT (the surrounding whole word(s)). Differs
     *  from [cuStart,cuEnd) so a zero-width insertion (e.g. "sw"->"saw") still
     *  highlights its word. Used for the highlight rect + hover/click hit-test. */
    hlStart: number
    hlEnd: number
    /** Display category (resolves colour / texture / popover label). */
    category: Category
    /** Bridge-supplied message (e.g. explanation). May be empty. */
    message: string
    /** Replacement strings; index 0 is the primary. Always at least one. */
    replacements: string[]
    /** Original text the suggestion is replacing (the exact edit span). */
    original: string
    /** Word-level preview of the primary replacement: the surrounding whole
     *  word(s) before vs after the edit (e.g. "was" -> "were" even though the
     *  raw span is "as" -> "ere"). Display only — apply uses the exact span. */
    diffOriginal: string
    diffCorrected: string
    /** True when the primary correction removes the text (deletion). */
    diffIsDeletion: boolean
    /** The original UTF-8 byte span from the bridge (kept for re-check + signal). */
    byteSpan: { start: number; end: number }
    /** Bridge model tag (kept for signal context). */
    model: BridgeSuggestion['model']
    /** Bridge rule id (kept for signal context). */
    ruleId?: string
    /** True for fast-path preview frames (no id, Apply disabled until the
     *  final frame replaces the item). Set per-frame by the caller, never
     *  inferred from a missing id (a failed log also yields id-less FINAL
     *  items, which must stay fully actionable for apply-without-signal). */
    preview?: boolean
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

/** Options for buildRenderableItems. */
export interface BuildItemsOptions {
    /** Mark every produced item as a fast-path preview (see RenderableItem.preview). */
    preview?: boolean
}

/**
 * Transform one /correct-shaped response into renderable items. Pure and
 * synchronous — the SSE staged path calls this once per frame; runCheck
 * wraps it for the single-shot path.
 */
export function buildRenderableItems(
    text: string,
    res: CorrectResponse,
    deps: Omit<RunCheckDeps, 'correct'> = {},
    opts: BuildItemsOptions = {},
): RunCheckResult {
    const verify = deps.verify ?? verifyByteSpan
    const derive = deps.derive ?? ((s: BridgeSuggestion) => deriveCategory(s))

    const items: RenderableItem[] = []
    let dropped = 0
    // Defensive: a malformed response (missing/non-array suggestions) must not
    // throw inside the orchestrator and kill the check; treat it as "no edits".
    const suggestions = Array.isArray(res?.suggestions) ? res.suggestions : []
    for (const s of suggestions) {
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
        const diff = wordLevelDiff(text, cu.start, cu.end, replacements[0] ?? '')
        items.push({
            id: s.id,
            cuStart: cu.start,
            cuEnd: cu.end,
            hlStart: diff.wordStart,
            hlEnd: diff.wordEnd,
            category: derive(s),
            message: s.message ?? '',
            replacements,
            original,
            diffOriginal: diff.original,
            diffCorrected: diff.corrected,
            diffIsDeletion: diff.isDeletion,
            byteSpan: { start: s.span.start, end: s.span.end },
            model: s.model,
            ruleId: s.ruleId,
            preview: opts.preview || undefined,
        })
    }
    return { items, dropped }
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
    const res = await deps.correct(text)
    return buildRenderableItems(text, res, deps)
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
