import { describe, expect, it } from 'vitest'
import { tooltipFor } from './chatbar-tooltip'
import { badgeStateFor } from './chatbar-badge'

describe('tooltipFor', () => {
    it('reports "paused" when paused, regardless of count', () => {
        expect(tooltipFor({ count: 0, paused: true })).toBe('GrammarForge — paused')
        expect(tooltipFor({ count: 7, paused: true })).toBe('GrammarForge — paused')
    })
    it('singularises at exactly one issue', () => {
        expect(tooltipFor({ count: 1, paused: false })).toBe('GrammarForge — 1 issue')
    })
    it('pluralises at zero and many issues', () => {
        expect(tooltipFor({ count: 0, paused: false })).toBe('GrammarForge — 0 issues')
        expect(tooltipFor({ count: 5, paused: false })).toBe('GrammarForge — 5 issues')
        expect(tooltipFor({ count: 42, paused: false })).toBe('GrammarForge — 42 issues')
    })
})

// P1-6(b): chatbar.test.ts never rendered the badge — only tooltipFor was
// covered. badgeStateFor is the pure extraction of the ChatBarButtonRoot
// ternary (chatbar.ts) that picks which badge (numeric count / pulsing AI
// pip / green all-clear check / none) renders over the chatbar icon. These
// tests exercise every state the review flagged as untested: the pip
// during a fast-check with zero items so far, the clean checkmark once
// settled with zero items, and paused-hides-badge (which wins over every
// other signal — the icon's power glyph is the sole "this is off" cue).
describe('badgeStateFor', () => {
    it('hides the badge entirely when paused, regardless of count or phase', () => {
        expect(badgeStateFor({ count: 0, paused: true, phase: 'done' })).toBeNull()
        expect(badgeStateFor({ count: 5, paused: true, phase: 'fast' })).toBeNull()
    })
    it('shows the numeric count badge whenever count > 0, in either phase', () => {
        expect(badgeStateFor({ count: 1, paused: false, phase: 'done' })).toBe('count')
        expect(badgeStateFor({ count: 3, paused: false, phase: 'fast' })).toBe('count')
    })
    it('shows the pulsing AI-refining pip when count is 0 and the LLM pass is in flight', () => {
        expect(badgeStateFor({ count: 0, paused: false, phase: 'fast' })).toBe('pip')
    })
    it('shows the clean all-clear check when count is 0 and the check has settled', () => {
        expect(badgeStateFor({ count: 0, paused: false, phase: 'done' })).toBe('clean')
    })
    it('count takes priority over phase (a fast-phase render with items is still "count")', () => {
        // Guards against a future refactor accidentally checking phase
        // before count (which would show the AI pip even with suggestions
        // already visible).
        expect(badgeStateFor({ count: 2, paused: false, phase: 'fast' })).toBe('count')
    })
})
