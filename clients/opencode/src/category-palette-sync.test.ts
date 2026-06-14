import { describe, expect, test } from 'vitest'
import { CATEGORY_FG } from './category-palette'
import { CATEGORY_META, type Category } from '@/api/category'

describe('category-palette sync (shared source of truth)', () => {
    test('CATEGORY_FG mirrors CATEGORY_META.badge for every Category', () => {
        const categories = Object.keys(CATEGORY_META) as Category[]
        expect(Object.keys(CATEGORY_FG).sort()).toEqual([...categories].sort())
        for (const cat of categories) {
            expect(CATEGORY_FG[cat]).toBe(CATEGORY_META[cat].badge)
        }
    })
})
