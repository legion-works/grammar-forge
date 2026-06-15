// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
    buildStatsViewModel,
    mountStatsView,
    type StatsViewDeps,
} from '@/overlay/stats-view'
import type { StatsResponse } from '@/api/types'

const baseStats: StatsResponse = {
    corrections: 96,
    edits_total: 96,
    edits_accepted: 92,
    edits_rejected: 3,
    edits_ignored: 1,
    acceptance_rate: 0.96,
    top_issues: { spelling: 38, grammar: 54, punctuation: 22, style: 14, typography: 6 },
    streak: 5,
    words_this_week: 3140,
}

function mkContainer(): HTMLElement {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host
}

function mkDeps(overrides: Partial<StatsViewDeps> = {}): StatsViewDeps {
    return {
        loadStats: vi.fn<StatsViewDeps['loadStats']>(async () => baseStats),
        loadDict: vi.fn<StatsViewDeps['loadDict']>(async () => ['GECToR', 'Vencord']),
        removeDictWord: vi.fn<StatsViewDeps['removeDictWord']>(async () => undefined),
        ...overrides,
    }
}

describe('buildStatsViewModel (pure data → view-model)', () => {
    it('formats words_this_week with thousands separators', () => {
        const m = buildStatsViewModel({ ...baseStats, words_this_week: 4812 }, [])
        expect(m.wordsLabel).toBe('4,812')
    })

    it('formats edits_total as the suggestions label', () => {
        const m = buildStatsViewModel({ ...baseStats, edits_total: 128 }, [])
        expect(m.suggestionsLabel).toBe('128')
    })

    it('formats acceptance_rate as a percentage (rounded)', () => {
        expect(buildStatsViewModel({ ...baseStats, acceptance_rate: 0.967 }, []).acceptanceLabel).toBe('97%')
        expect(buildStatsViewModel({ ...baseStats, acceptance_rate: 1.0 }, []).acceptanceLabel).toBe('100%')
    })

    it('falls back to 100% when acceptance_rate is missing', () => {
        const { acceptance_rate: _drop, ...rest } = baseStats
        const m = buildStatsViewModel(rest as StatsResponse, [])
        expect(m.acceptanceLabel).toBe('100%')
    })

    it('clamps acceptance_rate to [0, 1]', () => {
        expect(buildStatsViewModel({ ...baseStats, acceptance_rate: 1.5 }, []).acceptanceLabel).toBe('100%')
        expect(buildStatsViewModel({ ...baseStats, acceptance_rate: -0.2 }, []).acceptanceLabel).toBe('0%')
    })

    it('reports the streak as a non-negative integer string', () => {
        expect(buildStatsViewModel({ ...baseStats, streak: 6 }, []).streakLabel).toBe('6')
        expect(buildStatsViewModel({ ...baseStats, streak: -3 }, []).streakLabel).toBe('0')
        expect(buildStatsViewModel({ ...baseStats, streak: 4.9 }, []).streakLabel).toBe('4')
    })

    it('sorts top-issues bars by count (descending) and scales widths to the max', () => {
        const m = buildStatsViewModel(baseStats, [])
        const labels = m.bars.map((b) => b.label)
        expect(labels).toEqual(['Grammar', 'Spelling', 'Punctuation', 'Style', 'Typography'])
        // Grammar is the max (54) → 100%. Spelling (38) → 38/54*100 ≈ 70.4%.
        const gram = m.bars.find((b) => b.category === 'grammar')!
        const spell = m.bars.find((b) => b.category === 'spelling')!
        expect(gram.widthPct).toBe(100)
        expect(spell.widthPct).toBeCloseTo(70.4, 1)
        expect(gram.color).toBe('#eab308') // grammar dot
    })

    it('drops zero-count categories from the bar list', () => {
        const m = buildStatsViewModel(
            { ...baseStats, top_issues: { spelling: 5, grammar: 0, punctuation: 3 } },
            [],
        )
        expect(m.bars.map((b) => b.category)).toEqual(['spelling', 'punctuation'])
    })

    it('returns an empty bar list when top_issues is empty', () => {
        const m = buildStatsViewModel({ ...baseStats, top_issues: {} }, [])
        expect(m.bars).toEqual([])
    })

    it('sorts the dictionary alphabetically', () => {
        const m = buildStatsViewModel(baseStats, ['Vencord', 'GECToR', 'alpha'])
        expect(m.dictWords).toEqual(['alpha', 'GECToR', 'Vencord'])
    })

    it('handles a negative or non-finite words_this_week as zero (defensive)', () => {
        expect(buildStatsViewModel({ ...baseStats, words_this_week: -5 }, []).wordsLabel).toBe('0')
        expect(buildStatsViewModel({ ...baseStats, words_this_week: NaN }, []).wordsLabel).toBe('0')
    })
})

describe('mountStatsView (DOM mount + injected deps)', () => {
    it('mounts a .gf-stats section in the container and shows the loaded view after deps resolve', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        // Wait for the microtask + a tick for the async load.
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const root = container.querySelector('.gf-stats')
        expect(root).not.toBeNull()
        // Stat grid renders all four cards.
        const cards = root?.querySelectorAll('.gf-statcard')
        expect(cards?.length).toBe(4)
        // Words card shows the formatted count.
        const value = Array.from(cards ?? []).find((c) =>
            c.querySelector('.gf-statcard__label')?.textContent === 'Words this week',
        )?.querySelector('.gf-statcard__value')?.textContent
        expect(value).toBe('3,140')
        handle.destroy()
    })

    it('renders the dictionary chips with a × remove button per word', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const chips = container.querySelectorAll('.gf-dictchip')
        expect(chips.length).toBe(2)
        expect(chips[0]?.textContent).toContain('GECToR')
        const remove = chips[0]?.querySelector('button[aria-label]') as HTMLButtonElement
        expect(remove.getAttribute('aria-label')).toBe('Remove GECToR')
        handle.destroy()
    })

    it('renders one .gf-bar per category in the top-issues list', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const bars = container.querySelectorAll('.gf-bar')
        expect(bars.length).toBe(5)
        handle.destroy()
    })

    it('clicking a remove button calls removeDictWord and refreshes both sources', async () => {
        const container = mkContainer()
        const removeDictWord = vi.fn<StatsViewDeps['removeDictWord']>(async () => undefined)
        const loadDict = vi
            .fn<StatsViewDeps['loadDict']>()
            .mockResolvedValueOnce(['GECToR', 'Vencord'])
            .mockResolvedValueOnce(['Vencord'])
        const handle = mountStatsView(container, mkDeps({ removeDictWord, loadDict }))
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const removeBtn = container.querySelector('.gf-dictchip button') as HTMLButtonElement
        removeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(removeDictWord).toHaveBeenCalledWith('GECToR')
        // Wait for refresh to settle.
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const chips = container.querySelectorAll('.gf-dictchip')
        expect(chips.length).toBe(1)
        expect(chips[0]?.textContent).toContain('Vencord')
        // loadDict was called twice: initial + after remove.
        expect(loadDict).toHaveBeenCalledTimes(2)
        handle.destroy()
    })

    it('renders the "Computed locally" footer note', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const note = container.querySelector('.gf-stats__note')
        expect(note).not.toBeNull()
        expect(note?.textContent).toContain('Computed locally')
        handle.destroy()
    })

    it('shows an empty-state message when the dictionary is empty', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps({ loadDict: async () => [] }))
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const empty = container.querySelector('.gf-stats__empty')
        expect(empty).not.toBeNull()
        expect(empty?.textContent).toContain('No custom words yet')
        handle.destroy()
    })

    it('falls back to a Retry affordance when loadStats rejects (does not throw)', async () => {
        const container = mkContainer()
        const loadStats = vi
            .fn<StatsViewDeps['loadStats']>()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(baseStats)
        const handle = mountStatsView(container, mkDeps({ loadStats }))
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const err = container.querySelector('.gf-stats__error')
        expect(err).not.toBeNull()
        // Retry button wires a refresh.
        const retry = err?.querySelector('button') as HTMLButtonElement
        retry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        // After retry the loaded state appears.
        const cards = container.querySelectorAll('.gf-statcard')
        expect(cards.length).toBe(4)
        handle.destroy()
    })

    it('keeps the dictionary list intact when loadDict rejects (degraded mode)', async () => {
        const container = mkContainer()
        const handle = mountStatsView(
            container,
            mkDeps({ loadDict: async () => Promise.reject(new Error('boom')) }),
        )
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        // Stats still loaded, dict shows nothing (no chip list, no error).
        const chips = container.querySelectorAll('.gf-dictchip')
        expect(chips.length).toBe(0)
        const cards = container.querySelectorAll('.gf-statcard')
        expect(cards.length).toBe(4)
        handle.destroy()
    })

    it('destroy() removes the section; isOpen() reports false afterwards', async () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        expect(handle.isOpen()).toBe(true)
        handle.destroy()
        expect(handle.isOpen()).toBe(false)
        expect(container.querySelector('.gf-stats')).toBeNull()
    })

    it('destroy() is idempotent', () => {
        const container = mkContainer()
        const handle = mountStatsView(container, mkDeps())
        handle.destroy()
        expect(() => handle.destroy()).not.toThrow()
    })

    it('refresh() can be called manually; collapses concurrent refreshes', async () => {
        const container = mkContainer()
        const loadStats = vi.fn<StatsViewDeps['loadStats']>(async () => baseStats)
        const handle = mountStatsView(container, mkDeps({ loadStats }))
        await new Promise((r) => setTimeout(r, 0))
        await Promise.resolve()
        const callsBefore = loadStats.mock.calls.length
        // Two concurrent refreshes → only one underlying loadStats call.
        await Promise.all([handle.refresh(), handle.refresh()])
        expect(loadStats.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1)
        handle.destroy()
    })
})
