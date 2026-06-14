# GrammarForge Browser Extension

Privacy-first browser extension (Chrome + Firefox, MV3) that surfaces grammar, spelling,
and punctuation corrections inline on web text fields by talking to your **local**
[GrammarForge bridge](../../) — no cloud calls. Built with WXT + React + TypeScript.

> Status: scaffolding (Phase 2a). See `.opencode/specs/2026-06-09-browser-extension-design.md`
> and `.opencode/plans/2026-06-09-ws-b-browser-extension.md`.

## Develop

```bash
pnpm install
pnpm dev            # Chrome (loads an unpacked dev build)
pnpm dev:firefox    # Firefox
```

## Quality gate

```bash
pnpm check          # oxfmt --check && oxlint && wxt prepare && tsc --noEmit && vitest run && wxt build
```

Individual steps: `pnpm fmt` / `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build`.

## Configuration

The bridge endpoint defaults to `http://localhost:8000` (see `.env.example`). Non-local
endpoints are refused unless explicitly enabled in the extension's options (privacy
invariant — see the design spec).

## Hotkeys

- **Accept suggestion** (default `Alt + .`) — applies the first suggestion in the
  focused field.
- **Rephrase** (default `Ctrl + /`) — rephrases the focused field's selection, or
  the whole field if nothing is selected.

## Attribution

DOM techniques adapted (MIT) from [`codextde/textchecker`](https://github.com/codextde/textchecker);
see `THIRD_PARTY_NOTICES.md`.
