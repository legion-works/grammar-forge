import type { BridgeSuggestion, Category } from '@/api/types'

export const CATEGORY_META: Record<
    Category,
    {
        label: string
        badge: string
        underline: string
        underlineStyle: 'wavy' | 'dotted' | 'solid'
        underlineWidth: number
        priority: number
    }
> = {
    spelling: {
        label: 'Spelling',
        badge: '#ef4444',
        underline: '#dc2626',
        underlineStyle: 'wavy',
        underlineWidth: 2,
        priority: 5,
    },
    grammar: {
        label: 'Grammar',
        badge: '#eab308',
        underline: '#ca8a04',
        underlineStyle: 'wavy',
        underlineWidth: 2,
        priority: 4,
    },
    punctuation: {
        label: 'Punctuation',
        badge: '#3b82f6',
        underline: '#2563eb',
        underlineStyle: 'wavy',
        underlineWidth: 2,
        priority: 3,
    },
    style: {
        label: 'Style',
        badge: '#8b5cf6',
        underline: '#7c3aed',
        underlineStyle: 'dotted',
        underlineWidth: 2,
        priority: 2,
    },
    typography: {
        label: 'Typography',
        badge: '#6b7280',
        underline: '#6b7280',
        underlineStyle: 'solid',
        underlineWidth: 1,
        priority: 1,
    },
    unknown: {
        label: 'Issue',
        badge: '#9ca3af',
        underline: '#9ca3af',
        underlineStyle: 'dotted',
        underlineWidth: 1,
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
