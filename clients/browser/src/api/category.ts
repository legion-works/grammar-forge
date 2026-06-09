import type { BridgeSuggestion, Category } from '@/api/types'

export const CATEGORY_META: Record<
    Category,
    {
        label: string
        badge: string
        tint: string
        priority: number
    }
> = {
    spelling: {
        label: 'Spelling',
        badge: '#ef4444',
        tint: '#dc2626',
        priority: 5,
    },
    grammar: {
        label: 'Grammar',
        badge: '#eab308',
        tint: '#ca8a04',
        priority: 4,
    },
    punctuation: {
        label: 'Punctuation',
        badge: '#3b82f6',
        tint: '#2563eb',
        priority: 3,
    },
    style: {
        label: 'Style',
        badge: '#8b5cf6',
        tint: '#7c3aed',
        priority: 2,
    },
    typography: {
        label: 'Typography',
        badge: '#6b7280',
        tint: '#6b7280',
        priority: 1,
    },
    unknown: {
        label: 'Issue',
        badge: '#9ca3af',
        tint: '#9ca3af',
        priority: 0,
    },
}

const VALID: ReadonlySet<string> = new Set(Object.keys(CATEGORY_META))

/**
 * Resolve a suggestion's display category. Prefers the bridge wire `category`
 * when present and recognised; otherwise derives from `model` (+ ruleId). The
 * wire has NO LintKind field, so a Harper suggestion without a wire category
 * cannot be distinguished from grammar client-side — which is exactly why the
 * bridge (WS-A) emits `category`.
 */
export function deriveCategory(
    s: Pick<BridgeSuggestion, 'category' | 'model' | 'ruleId' | 'span' | 'replacement'>,
): Category {
    if (s.category && VALID.has(s.category)) return s.category as Category
    switch (s.model) {
        case 'gector':
            return 'grammar'
        case 'llm':
            return 'grammar'
        case 'harper':
            return 'grammar'
        case 'lt_rule':
            return 'unknown'
        default:
            return 'unknown'
    }
}
