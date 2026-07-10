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
//
// Re-exported (not hand-copied) from the browser client's
// clients/browser/src/lib/legion-tokens.ts — the single source of truth
// for these Legion Works color constants. This file keeps its own
// (dark-only) names for chatbar.ts's existing call sites, but the VALUES
// now come from one place instead of being duplicated hex literals.
import { LEGION } from '@/lib/legion-tokens'

export const LEGION_ACCENT = LEGION.dark.accent // --gf-accent (dark)
export const LEGION_ACCENT_INK = LEGION.dark.accentInk // --gf-accent-ink — dark ink text ON cyan, never white
export const LEGION_PURPLE = LEGION.dark.purple // --gf-ai-violet (Geth Purple, AI refining pip)
export const LEGION_SUCCESS = LEGION.dark.success // --gf-success (Tokyo green, all-clear)
