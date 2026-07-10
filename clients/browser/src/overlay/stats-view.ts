// The W2-4 Stats tab — the retention surface. Renders the four-card
// "this week" grid (words / suggestions / acceptance / streak), the
// top-issues bars, and the personal-dictionary chip list. Sits INSIDE
// the W2b review panel's body slot (panel.ts exposes its body container
// via `getBodyContainer()`); the orchestrator wires the Stats-tab click
// to `mountStatsView(container, deps)`.
//
// Surface invariants (per the W2b spec):
//   - Pure data → view-model mapping in `buildStatsViewModel` (the only
//     piece that does no DOM). Unit-tested in isolation.
//   - Async data fetching is INJECTED via `StatsViewDeps` so the module
//     is testable with a fake (no bridge, no network).
//   - Loading + empty + error states are all rendered distinctly; the
//     surface never shows a "stats: undefined" flash.
//   - Surface: caller-provided container, no self-measure, opacity:1
//     default, transform-only entrance handled by the host panel.
//
// Per flows.md §10 + reference DC `makeStats` lines 831-863 + markup.html
// §4: 2x2 stat grid, Top-issues bar list (one bar per category, scaled
// to the max), Personal-dictionary chips with `×` remove buttons, and
// the "Computed locally — nothing leaves your machine." footer.

import { CATEGORY_META } from '@/api/category'
import type { Category, StatsResponse } from '@/api/types'

/** Pure data shape the DOM reads. Computed once per refresh from the
 *  StatsResponse + the dictionary list — never the StatsResponse itself,
 *  so the renderer can be tested with synthetic data and the bridge
 *  payload can evolve without rippling into the DOM. */
export interface StatsViewModel {
    /** "3,140" — pre-formatted with thousands separators. */
    wordsLabel: string
    /** Optional sub-line (e.g. "+12% vs last week") — only rendered
     *  when present. */
    weeklyDelta?: string
    /** "96" — suggestions checked (uses `edits_total`, the cumulative
     *  number the bridge tracks across the lifetime of the local DB). */
    suggestionsLabel: string
    /** "100%" — rounded percentage from `acceptance_rate` (0–1) when
     *  present, otherwise "100%" as the floor (no signal events yet). */
    acceptanceLabel: string
    /** "5" — current day-streak. */
    streakLabel: string
    /** Per-category top-issues bars, sorted descending by count, with
     *  the relative `widthPct` pre-computed. Empty array → section hides
     *  the bar list but still renders the heading. */
    bars: ReadonlyArray<StatsBar>
    /** Personal-dictionary words, sorted alphabetically. */
    dictWords: ReadonlyArray<string>
}

export interface StatsBar {
    category: Category
    label: string
    count: number
    /** 0–100, the bar's `width` percentage. Normalised against the
     *  largest count in the list so the longest bar always fills. */
    widthPct: number
    /** Bar fill colour — matches the category dot the panel list uses. */
    color: string
}

/** Async dependency bundle. The orchestrator wires real bridge calls;
 *  the unit tests pass a fake that resolves synchronously via Promise. */
export interface StatsViewDeps {
    /** Fetch the latest stats. May reject — the view shows a gentle
     *  error state. */
    loadStats: () => Promise<StatsResponse>
    /** Fetch the personal-dictionary word list. May reject — the view
     *  shows the existing cached list (or empty) on error. */
    loadDict: () => Promise<readonly string[]>
    /** Remove a word from the dictionary. The view re-fetches stats
     *  and dict on success; on reject the chip stays put. */
    removeDictWord: (word: string) => Promise<void>
}

export interface StatsViewHandle {
    /** Tear down the view and its listeners. Safe to call twice. */
    destroy: () => void
    /** True while the view is mounted. */
    isOpen: () => boolean
    /** Re-fetch both data sources and re-render. Called after a remove
     *  succeeds. Idempotent. */
    refresh: () => Promise<void>
}

/** Map a StatsResponse + dict list to the renderer's view-model. PURE —
 *  no DOM, no I/O — so it can be unit-tested in isolation. The bridge
 *  response shape can drift without rippling into the DOM. */
export function buildStatsViewModel(
    stats: StatsResponse,
    dictWords: readonly string[],
): StatsViewModel {
    const wordsLabel = formatThousands(stats.words_this_week)
    const suggestionsLabel = formatThousands(stats.edits_total)
    const acceptanceLabel = formatAcceptance(stats.acceptance_rate)
    const streakLabel = String(Math.max(0, Math.trunc(stats.streak)))
    const bars = buildBars(stats.top_issues)
    const sortedDict = [...dictWords].sort((a, b) => a.localeCompare(b))
    return {
        wordsLabel,
        weeklyDelta: undefined, // not in StatsResponse yet; W3+ can extend
        suggestionsLabel,
        acceptanceLabel,
        streakLabel,
        bars,
        dictWords: sortedDict,
    }
}

const CATEGORY_ORDER: readonly Category[] = [
    'spelling',
    'grammar',
    'punctuation',
    'style',
    'typography',
    'unknown',
] as const

function buildBars(
    top_issues: Readonly<Record<string, number>>,
): StatsBar[] {
    const entries: Array<{ category: Category; count: number }> = []
    for (const cat of CATEGORY_ORDER) {
        const count = top_issues[cat]
        if (typeof count === 'number' && count > 0) {
            entries.push({ category: cat, count })
        }
    }
    // Append any unknown / future categories that aren't in the canonical
    // order, alphabetically, so the bar list never drops data the bridge
    // knows about.
    for (const [k, v] of Object.entries(top_issues)) {
        if (CATEGORY_ORDER.includes(k as Category)) continue
        if (typeof v === 'number' && v > 0) {
            entries.push({ category: 'unknown', count: v })
        }
    }
    entries.sort((a, b) => b.count - a.count)
    if (entries.length === 0) return []
    const max = entries[0]!.count
    return entries.map((e) => ({
        category: e.category,
        label: CATEGORY_META[e.category]?.label ?? e.category,
        count: e.count,
        widthPct: max > 0 ? Math.max(2, (e.count / max) * 100) : 0,
        color: CATEGORY_META[e.category]?.badge ?? '#9ca3af',
    }))
}

function formatThousands(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '0'
    return Math.trunc(n).toLocaleString('en-US')
}

function formatAcceptance(rate: number | undefined): string {
    if (rate === undefined || !Number.isFinite(rate)) return '100%'
    const pct = Math.max(0, Math.min(1, rate)) * 100
    return `${String(Math.round(pct))}%`
}

/**
 * Mount the Stats view into the supplied container. The container is
 * cleared and replaced with a `.gf-stats` tree that handles loading,
 * empty, loaded, and error states. The data loaders are INJECTED so
 * unit tests can swap a fake client in.
 *
 *   - `loadStats` / `loadDict` are awaited at mount and on `refresh()`.
 *   - Remove chips call `removeDictWord(word)`, then `refresh()`.
 *   - The view owns the in-flight guard (concurrent refreshes collapse).
 *
 * The view is a SURFACE — the caller passes a container element, the
 * view does not measure or position itself. Entrance is transform-only
 * (caller's host panel handles the animation).
 */
export function mountStatsView(
    container: HTMLElement,
    deps: StatsViewDeps,
): StatsViewHandle {
    let mounted = true
    let inFlight = false

    const root = document.createElement('section')
    root.className = 'gf-stats'
    root.setAttribute('role', 'region')
    root.setAttribute('aria-label', 'Stats')
    // The loading -> data/error swap below (renderLoading / renderLoaded /
    // renderError, all called via root.textContent = '' + rebuild) must be
    // announced to screen readers — without aria-live the content change is
    // silent to AT users, who'd see no indication the Stats tab ever
    // finished loading. Matches the streaming-banner pattern in panel.ts
    // (renderReviewBodyContent's .gf-banner) and toast.ts's aria-live pill.
    root.setAttribute('aria-live', 'polite')
    // Initial placeholder (loading) — rendered off-DOM first, then
    // swapped in atomically so there's no intermediate empty flash.
    renderLoading(root)
    // Atomic swap: replaceChildren replaces all existing content in one
    // operation — no intermediate empty state visible to the user.
    container.replaceChildren(root)

    const refresh = async (): Promise<void> => {
        if (inFlight) return
        inFlight = true
        try {
            const [stats, dict] = await Promise.all([
                deps.loadStats().catch(() => null),
                deps.loadDict().catch(() => null),
            ])
            if (!mounted) return
            if (stats === null) {
                renderError(root, () => {
                    void refresh()
                })
                return
            }
            const m = buildStatsViewModel(
                stats,
                dict ?? [],
            )
            renderLoaded(root, m, async (word: string) => {
                try {
                    await deps.removeDictWord(word)
                } catch {
                    return
                }
                await refresh()
            })
        } finally {
            inFlight = false
        }
    }

    void refresh()

    return {
        destroy: () => {
            mounted = false
            root.remove()
        },
        isOpen: () => mounted && root.isConnected,
        refresh,
    }
}

function renderLoading(root: HTMLElement): void {
    root.textContent = ''
    const grid = el(root, 'div', 'gf-stats__grid')
    for (let i = 0; i < 4; i++) {
        const card = el(grid, 'div', 'gf-statcard')
        card.appendChild(el(card, 'span', 'gf-statcard__value gf-skel'))
        el(card, 'span', 'gf-statcard__label').textContent = ' '
    }
}

function renderError(
    root: HTMLElement,
    retry: () => void,
): void {
    root.textContent = ''
    const err = el(root, 'div', 'gf-stats__error')
    err.textContent = 'Could not load stats.'
    const btn = el(err, 'button', 'gf-textbtn') as HTMLButtonElement
    btn.type = 'button'
    btn.textContent = 'Retry'
    btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        retry()
    })
}

function renderLoaded(
    root: HTMLElement,
    m: StatsViewModel,
    onRemove: (word: string) => Promise<void>,
): void {
    root.textContent = ''
    const grid = el(root, 'div', 'gf-stats__grid')
    appendStatCard(grid, m.wordsLabel, 'Words this week', m.weeklyDelta)
    appendStatCard(grid, m.suggestionsLabel, 'Suggestions checked', undefined)
    appendStatCard(grid, m.acceptanceLabel, 'Acceptance', undefined)
    appendStatCard(grid, m.streakLabel, 'Day streak', undefined)

    if (m.bars.length > 0) {
        el(root, 'h4', 'gf-stats__sec').textContent = 'Top issues this week'
        const bars = el(root, 'div', 'gf-stats__bars')
        for (const bar of m.bars) {
            const row = el(bars, 'div', 'gf-bar')
            el(row, 'span', 'gf-bar__label').textContent = bar.label
            const track = el(row, 'div', 'gf-bar__track')
            const fill = el(track, 'i', 'gf-bar__fill')
            fill.style.width = `${String(bar.widthPct.toFixed(1))}%`
            fill.style.background = bar.color
            el(row, 'b', 'gf-bar__count').textContent = String(bar.count)
        }
    }

    el(root, 'h4', 'gf-stats__sec').textContent = 'Personal dictionary'
    const chips = el(root, 'div', 'gf-dictchips')
    if (m.dictWords.length === 0) {
        const empty = el(chips, 'span', 'gf-stats__empty')
        empty.textContent = 'No custom words yet — add from any spelling card.'
    } else {
        for (const word of m.dictWords) {
            const chip = el(chips, 'span', 'gf-dictchip')
            chip.textContent = word
            const remove = el(chip, 'button', 'gf-dictchip__x') as HTMLButtonElement
            remove.type = 'button'
            remove.setAttribute('aria-label', `Remove ${word}`)
            remove.textContent = '\u00D7'
            remove.addEventListener('click', (e) => {
                e.preventDefault()
                e.stopPropagation()
                void onRemove(word)
            })
        }
    }

    const note = el(root, 'div', 'gf-stats__note')
    note.textContent =
        'Computed locally from your bridge — nothing leaves your machine.'
}

function appendStatCard(
    parent: HTMLElement,
    value: string,
    label: string,
    sub: string | undefined,
): void {
    const card = el(parent, 'div', 'gf-statcard')
    const val = el(card, 'b', 'gf-statcard__value')
    val.textContent = value
    el(card, 'span', 'gf-statcard__label').textContent = label
    if (sub) {
        const subEl = el(card, 'i', 'gf-statcard__sub')
        subEl.textContent = sub
    }
}

function el(parent: Node, tag: string, className?: string): HTMLElement {
    const node = document.createElement(tag)
    if (className) node.className = className
    parent.appendChild(node)
    return node
}
