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
| Rephrase hotkey     | `ctrl+/`                | Rephrases the focused composer's selection, or the whole composer if nothing is selected.                                                                                |
| Check pasted text   | off                     | When off, pasted text is never checked (typed input only).                                                                                                              |

## Chat-bar button

A GrammarForge icon sits in the message-composer toolbar (same slot as
Vencord's Translate button). It shows a live count badge whenever the
active composer has suggestions. Hover over the button to surface the
status pill anchored to the chat-bar (300 ms leave-grace, so dragging
into the pill keeps it open). Click the button to toggle the
corrections panel:

- **Apply all** — accept every suggestion in the active composer.
- **Apply one** — accept a single suggestion from the list.
- **Recheck** — re-run the bridge on the current text.
- **Undo** — reverts the last apply (per-field; single slot).
- **Rephrase** — rephrase the current text selection; if there is no
  selection, rephrase the whole field.
- **Power button (on the pill)** — pause / resume checking. While
  paused, the chat-bar icon is dimmed and the tooltip reads
  "GrammarForge — paused".

The underline popover gains **Add to dictionary** for spelling
suggestions; adding a word suppresses future suggestions for it and
shows an Undo toast that re-enables them.

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
11. Hover the chat-bar button → status pill appears anchored to it.
12. Click the chat-bar button → corrections panel opens with the active composer's items.
13. **Apply all** on a multi-error message → every underlined token is fixed; the badge clears.
14. After applying, **Undo** on the panel → text restored to the pre-apply state; Undo button disables.
15. Select a sentence and click **Rephrase** on the panel → pending card → result card → Apply rewrites the selection; with no selection, the Rephrase card covers the whole field.
16. On a spelling suggestion, popover's **Add to dictionary** adds the word, suppresses future suggestions, and the toast's **Undo** re-enables them.
17. Click the pill's power button → icon dims, tooltip says "paused", no new checks fire; click again → re-checks the active composer immediately.

## Development

Source of truth is this directory — the synced copy in
`src/userplugins/grammarForge/` is a generated bundle; never edit it there.
Gates: `pnpm fmt && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
