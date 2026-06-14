// Derived from the shared CATEGORY_META.badge in clients/browser/src/api/category.ts —
// the canonical source of truth. This module is the THIN adapter that re-shapes
// the shared record into the per-category foreground color that the orchestrator
// passes to extmark.registerStyle and the panel passes to bordered-card border.
//
// If a new category is added, add it to CATEGORY_META in clients/browser/src/api/category.ts;
// the type union (Category) update propagates here automatically and the sync test
// (category-palette-sync.test.ts) catches any drift.

import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'

export const CATEGORY_FG: Record<Category, string> = Object.fromEntries(
    Object.entries(CATEGORY_META).map(([k, v]) => [k, v.badge]),
) as Record<Category, string>

export function categoryColor(category: string): string {
    return (CATEGORY_FG as Record<string, string>)[category]
        ?? CATEGORY_FG.unknown
        ?? '#9ca3af'
}
