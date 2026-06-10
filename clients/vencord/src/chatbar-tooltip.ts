// Tooltip string for a given orchestrator summary. Pure — exported for the
// unit test. Lives in its own file (no React / Vencord imports) so the test
// bundle never has to resolve Vencord's ambient modules under vitest.
export function tooltipFor(summary: { count: number; paused: boolean }): string {
    if (summary.paused) return 'GrammarForge — paused'
    const n = summary.count
    return `GrammarForge — ${n} issue${n === 1 ? '' : 's'}`
}
