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

- **A7 granular per-row clickable apply/ignore spans**: card-level `onMouseDown` stays.
  Per-row split targets (click "⏎ apply" vs "x ignore" independently) needs live
  `@opentui/solid` mouse event verification on `<text>` elements.
- **A4 suggestion-card diff-row wrapping**: suggestion card still renders single-line
  diffs (rare case). Rephrase card wrapping is implemented.
