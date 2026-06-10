import { describe, expect, it } from 'vitest'
import { tooltipFor } from './chatbar-tooltip'

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
