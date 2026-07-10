// Legion Works dark-theme hex literals used by chatbar.ts. The chatbar
// button renders in Discord's own React tree, OUTSIDE the GrammarForge
// overlay shadow root — the `--gf-*` custom properties the shared overlay
// CSS defines (clients/browser/src/overlay/styles.ts) are scoped to that
// shadow host and do not cascade there, so the values are inlined directly
// instead of resolved via CSS custom properties. Vencord's GF root is
// always dark (orchestrator.ts pins data-gf-theme="dark"), so only the
// dark-theme values are needed.
//
// Lives in its own file, with NO React / Vencord imports (mirrors
// chatbar-tooltip.ts), so chatbar-palette-sync.test.ts (P1-7) can import
// these under vitest without pulling in chatbar.ts's unresolvable
// `@api/ChatButtons` / `@webpack/common` ambient-module imports (those
// only exist at Vencord's own build time).
export const LEGION_ACCENT = '#86e1fc' // --gf-accent (dark)
export const LEGION_ACCENT_INK = '#0c1622' // --gf-accent-ink — dark ink text ON cyan, never white
export const LEGION_PURPLE = '#c099ff' // --gf-ai-violet (Geth Purple, AI refining pip)
export const LEGION_SUCCESS = '#c3e88d' // --gf-success (Tokyo green, all-clear)
