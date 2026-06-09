import { describe, expect, it } from 'vitest'
import { CATEGORY_META, deriveCategory } from '@/api/category'

describe('deriveCategory', () => {
    it('prefers the wire category when non-empty', () => {
        expect(
            deriveCategory({
                category: 'spelling',
                model: 'gector',
                span: { start: 0, end: 1 },
                replacement: '',
            }),
        ).toBe('spelling')
    })

    it('maps gector → grammar when category absent', () => {
        expect(
            deriveCategory({ model: 'gector', span: { start: 0, end: 1 }, replacement: '' }),
        ).toBe('grammar')
    })

    it('maps harper (no wire category) → grammar (cannot see LintKind on the wire)', () => {
        expect(
            deriveCategory({ model: 'harper', span: { start: 0, end: 1 }, replacement: '' }),
        ).toBe('grammar')
    })

    it('maps llm → grammar', () => {
        expect(deriveCategory({ model: 'llm', span: { start: 0, end: 1 }, replacement: '' })).toBe(
            'grammar',
        )
    })
})

describe('CATEGORY_META', () => {
    it('has all six categories with required fields', () => {
        for (const c of [
            'spelling',
            'grammar',
            'punctuation',
            'style',
            'typography',
            'unknown',
        ] as const) {
            expect(CATEGORY_META[c].label).toBeTruthy()
            expect(CATEGORY_META[c].tint).toMatch(/^#/)
        }
    })
})
