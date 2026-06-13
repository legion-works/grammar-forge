# GrammarForge — OpenCode TUI plugin

Grammar checking in OpenCode's prompt input, backed by a
[GrammarForge](../../README.md) bridge.

## Requirements

Your OpenCode build must include the **prompt facade** patch
(`feat/tui-prompt-facade` — `api.prompt` on the TUI plugin API). On an
unpatched build the plugin shows one warning toast at startup and stays
inert.

## Install

1. Build: `pnpm install && pnpm build` (produces `dist/tui.js`).
2. Register the plugin in your **TUI** config — project `tui.json` /
   `tui.jsonc`, or the global file at `~/.config/opencode/tui.jsonc`
   (override with the `OPENCODE_TUI_CONFIG` env var):

   ```json
   { "plugin": ["file:///path/to/grammar-forge/clients/opencode/dist"] }
   ```

3. Restart OpenCode.

TUI plugins are configured in `tui.json`, NOT in `opencode.json` —
`opencode.json`'s `plugin` array is the **server** plugin pipeline and
will not load this plugin (verified against
`packages/opencode/src/config/tui.ts` + `config/paths.ts:17`, which only
scans `tui.json`/`tui.jsonc` for the TUI side; and
`packages/opencode/src/config/tui-migrate.ts`, which does not migrate
plugin entries out of `opencode.json`).

The build emits `dist/package.json` alongside `dist/tui.js` — that
manifest's `exports` map declares the `./tui` entry the OpenCode loader
looks for, so the loader knows the bundle is tui-only and skips the
server entrypoint without erroring. The bundle is named `tui.js` (not
`index.*`) so OpenCode's file-plugin server-kind resolver, which falls
back to the directory's index.\* files, finds nothing and reports a
silent missing-stage skip.

Absolute paths in plugin entries are normalized to `file://` URLs by
`ConfigPlugin.resolvePluginSpec`
(`packages/opencode/src/config/plugin.ts:42-60`); the `file://` form is
explicitly accepted and survives the round-trip.

## Settings (plugin options)

The TUI plugin spec is the same `ConfigPluginV1.Spec` used by
`opencode.json` (see `packages/core/src/v1/config/plugin.ts:8`):
either a string (path/URL) or a tuple `[path, options]` where options
is a `Record<string, unknown>`. The same tuple form is therefore
supported in `tui.json` — `ConfigPlugin.resolvePluginSpec` preserves
`plugin[1]` through path normalization
(`packages/opencode/src/config/plugin.ts:58`).

```json
{
  "plugin": [
    [
      "file:///path/to/grammar-forge/clients/opencode/dist",
      {
        "bridgeUrl": "http://localhost:8000",
        "realtimeDelayMs": 500,
        "acceptHotkey": "ctrl+.",
        "allowRemoteBridge": false
      }
    ]
  ]
}
```

`allowRemoteBridge` is a privacy guard: with it off (default), only
localhost/private-network bridge URLs are accepted.

## Behaviour

- Typing pauses for `realtimeDelayMs` → the prompt text is checked →
  category-colored underlines appear on flagged ranges.
- `ctrl+.` applies the first suggestion (toast confirms) and re-checks.
- Pasted blocks, file attachments, and agent mentions are never flagged
  (their ranges are excluded). Limitation: pastes under 3 lines / 150
  chars are inserted as plain text by OpenCode and are therefore checked.
- Sending or clearing the prompt with open suggestions logs them as
  `ignored`.
- Bridge unreachable → silent idle; checking resumes on the next edit.

## Smoke checklist (manual, bridge on localhost:8000)

1. Type `I has a apple` → wait ~1 s → underlines appear in the prompt.
2. `ctrl+.` → first suggestion applies in place, toast confirms.
3. Paste a 5-line error-laden block → its range is not underlined.
4. Submit a prompt with open underlines → `curl localhost:8000/stats`
   shows the ignored count moved.
5. Stop the bridge → typing causes no errors; restart → next edit checks.
6. Navigate home ↔ session → underlines re-attach after typing resumes.

## Development

Gates: `pnpm fmt && pnpm exec oxlint && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm build`.
Shared pure modules come from `../browser/src` via the `@/` alias.
