// Chatbar badge-state derivation. Pure — exported for the unit test.
// Lives in its own file (no React / Vencord imports), mirroring
// chatbar-tooltip.ts, so chatbar.test.ts (P1-6b) can exercise the
// pip-during-fast-check / clean / paused-hidden states under vitest
// without resolving chatbar.ts's Vencord ambient-module imports
// (@api/ChatButtons, @webpack/common — those only exist at Vencord's
// own build time) or standing up a React renderer.
export type BadgeState = 'count' | 'pip' | 'clean' | null

/** Badge states (flows.md §6, Vencord column): count>0 → numeric badge
 *  (Legion cyan fill, dark ink text — never white-on-cyan); zero
 *  suggestions while the LLM pass is still in flight (`phase === 'fast'`)
 *  → the pulsing ✨ pip; zero suggestions once settled (`phase === 'done'`)
 *  → the green all-clear check. Paused hides the badge entirely — the
 *  icon's power glyph is the single "this is off" affordance (no
 *  redundant second signal). */
export function badgeStateFor(summary: {
    count: number
    paused: boolean
    phase: 'fast' | 'done'
}): BadgeState {
    if (summary.paused) return null
    if (summary.count > 0) return 'count'
    return summary.phase === 'fast' ? 'pip' : 'clean'
}
