# GrammarForge — Vencord plugin

Self-hosted grammar checking in Discord's message composer, backed by a
[GrammarForge](../../README.md) bridge.

## Install

1. Have a Vencord source checkout that injects into your Discord
   ([docs](https://docs.vencord.dev/installing/)).
2. From this directory:

   ```bash
   pnpm install
   VENCORD_REPO=/path/to/Vencord pnpm sync
   ```

3. In the Vencord checkout: `pnpm build`, then fully restart Discord.
4. Enable **GrammarForge** in Settings → Plugins. Works in Equicord too
   (same plugin system).

## Settings

| Setting             | Default                 | Notes                                                                                                                                                                   |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge URL          | `http://localhost:8000` | localhost/127.0.0.1 work out of the box (Vencord CSP allow-list). LAN/HTTPS hosts additionally need "Allow remote bridge" AND a Vencord CSP override + Discord restart. |
| Allow remote bridge | off                     | Privacy guard — your message drafts are sent to the bridge URL.                                                                                                         |
| Idle delay          | 500 ms                  | Debounce before checking.                                                                                                                                               |
| Accept hotkey       | `ctrl+.`                | Applies the first suggestion. Tab is deliberately not used (Discord autocomplete).                                                                                      |
| Check pasted text   | off                     | When off, pasted text is never checked (typed input only).                                                                                                              |

## Smoke checklist (manual, bridge running on localhost:8000)

1. Type `I has a apple` → wait ~1 s → underlines appear.
2. Click an underline → popover with word-diff; **Apply** fixes in place.
3. Press `ctrl+.` with an error present → first suggestion applies.
4. **Ignore once** → underline disappears, text unchanged.
5. Paste an error-laden paragraph (Check pasted text off) → no underlines until you type.
6. Discord search box stays underline-free (composer gate).
7. Inline message edit (`e` on your own message) → checking works there.
8. Disable plugin in settings → overlays vanish; re-enable → works without restart.
9. `curl localhost:8000/stats` → accepted/ignored counts move after Apply/Ignore.
10. Stop the bridge → typing logs no console errors (silent idle); restart bridge → next edit checks.

## Development

Source of truth is this directory — the synced copy in
`src/userplugins/grammarForge/` is a generated bundle; never edit it there.
Gates: `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
