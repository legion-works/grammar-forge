# GrammarForge OpenCode Plugin — Live Verification Harness

## Prerequisites

- Patched OpenCode core (feat/tui-prompt-facade branch). A checkout exists at
  `~/projects/opencode` — but the patched branch status is **UNVERIFIED**
  (discovered via `ls ~/projects/opencode`: AGENTS.md, package.json, packages/,
  etc. are present; branch state not checked).
- Bun >= 1.3.0 (the OpenCode runtime)
- Bridge running: `docker compose up -d bridge` (from the grammar-forge root)

## One-time setup

1. `cd ~/projects/opencode`
2. `bun install`
3. Add to `~/.config/opencode/opencode.jsonc` a `plugins` array entry:
   ```jsonc
   "plugins": [
     {
       "path": "~/projects/grammar-forge/clients/opencode"
     }
   ]
   ```
   (Path points at the MAIN checkout, not the worktree, so the symlinked
   node_modules resolve correctly. The `oc-plugin: ["tui"]` in package.json
   tells the host to load `exports["./tui"]` → `src/tui-entry.tsx`.)

## Build/CI smoke

```bash
cd ~/projects/grammar-forge/clients/opencode
CI=true node scripts/build.mjs
# Expected: exits 0, prints "build: source-shipped tui entry verified at src/tui-entry.tsx"
```

## Smoke test (live — DEFERRED)

**⚠️ Live verification is DEFERRED — needs the patched core binary.**
The steps below are documented but have NOT been confirmed:

1. Start the bridge:
   ```bash
   cd ~/projects/grammar-forge && docker compose up -d bridge
   ```
2. Start OpenCode from the patched core checkout:
   ```bash
   cd ~/projects/opencode && bun run …  # exact entry-point TBD
   ```
3. Verify the plugin loaded:
   ```bash
   GF_TUI_DEBUG=1 bun run … 2>&1 | grep "plugin teardown: orchestrator stop"
   ```
4. Type a sentence with a known grammar error (e.g. "He go to school") in the
   home prompt.
5. Verify: red underline appears under "go".
6. Verify: `ctrl+.` shows "Applied N suggestions" toast.

## Deferred items

- Patched core binary entry-point (bun run … command) — need to inspect the
  checkout's package.json scripts.
- opencode.jsonc plugin stanza — confirmed format from AGENTS.md, but not
  tested against a running build.
- Actual underline rendering — requires a running OpenCode with the prompt
  facade patch applied.

## v1 deferrals (2026-06-23 review)

- **A7 granular per-row clickable apply/ignore spans**: card-level `onMouseDown` stays
  (applies the pinned suggestion / accepts the rephrase from anywhere on the card).
  Per-row split targets (click "⏎ apply" vs "x ignore" independently), click-outside-
  card dismiss, wheel-scroll on a tall rephrase card, and click-an-alternative in a
  multi-option rephrase (opencode-interaction.md §4) all need live `@opentui/solid`
  mouse event verification (per-element hit targets, wheel events, global click-outside
  capture) that isn't possible without the patched OpenCode core binary (see "Smoke
  test (live — DEFERRED)" above). Every one of these already has a full keyboard
  equivalent (`return`/`x`/`ctrl+n`/`ctrl+p`/`esc`/`↑↓`/`tab`/`PgUp`/`PgDn`), so mouse
  stays a pure accelerator, not a functional gap, per §1's "mouse-optional" principle.
- **A4 suggestion-card diff-row wrapping (2026-07-10)**: DONE — `buildCardSpec` now
  word-wraps the diff row (same `wrapLines` helper as the rephrase card) when the
  original/replacement don't fit the card's inner width, and `tui-entry.tsx` grows
  `cardH` from `spec.contentRows` for both "suggestion" and "rephrase-result" kinds.
  Short diffs (the common case) render byte-identical to before.
- **Re-skin (2026-07-10)**: `card-spec.ts` (`DELETE_HEX`/`INSERT_HEX`/`DIM_HEX`/
  `REPHRASE_ACCENT_HEX`) and `tui-entry.tsx` (card background, status-line + ghost
  text color) now use the Legion Works OpenCode theme tokens (`--danger`/`--success`/
  `--text-muted`/`--purple-400`/`--bg-raised`, Tokyo Night dark values from
  `handoff/scss/_tokens.scss`) instead of ad-hoc hex. Category colors were already
  correct (sourced from `CATEGORY_META` via `category-palette.ts`) and are unchanged.
