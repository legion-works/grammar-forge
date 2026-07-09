# Handoff Prompt — paste to your coding agent

You are implementing the **GrammarForge** design on its real codebase. GrammarForge
is a self-hosted, privacy-first writing assistant with **three** clients in this
monorepo:
- `clients/browser/` — WXT + React browser extension (content overlay, popup,
  options). Talks to the local bridge via `src/api/client.ts`.
- `clients/vencord/` — a Vencord userplugin augmenting the Discord composer
  (`src/orchestrator.ts` + overlay modules).
- `clients/opencode/` — an OpenCode TUI plugin (keyboard-first prompt overlay;
  `src/orchestrator.ts`, `card-spec.ts`, `details-state.ts`, …).

A complete design + behavior spec is in `handoff/`. Read in order:
`README.md → HANDOFF_PROMPT.md → INSTRUCTIONS.md → LOGO.md → flows.md →
opencode-interaction.md`, with `scss/` + `markup.html` as the visual reference.
Five **working, clickable prototypes** ship in `handoff/reference/` — open them to
see exact intended behavior; they are the source of truth, match them.

## The visual system: Legion Works
GrammarForge is a **Legion Works Design System** product (Tokyo Night based). Every
GrammarForge surface pulls color/type/space/radius/glass from that system. The
host's own chrome stays native. Key facts:

- **Accent = Legion Cyan** `#86E1FC` dark / `#2F7D9C` light (NOT the old blue
  `#2563eb`). Because cyan is light, primary buttons use **dark ink** `#0C1622`,
  never white text.
- **Type:** Space Grotesk (wordmark/headings), Geist (UI/body), JetBrains Mono
  (all machine data). Not system-ui.
- **Glass:** translucent navy (dark) / white (light), `blur(22px) saturate(160%)`,
  hairline stroke, the `--glass-rim` specular inset. Use it for every floating GF
  surface; never for dense tables/long reading.
- **Warm accent:** IceTea Amber `#FF966C`, sparingly (never co-equal with cyan).
- **Category + band scales are unchanged** — spelling `#ef4444`, grammar
  `#eab308`, punctuation `#06b6d4`, style `#8b5cf6`; align `api/category.ts`
  `CATEGORY_META` to them (now DS tokens `--cat-*`).

Exact values: `scss/_tokens.scss`. If you can load the Legion Works token CSS into
each GF root, prefer `var(--accent)` etc. over hardcoding (it themes for free).

## The new brand mark
GrammarForge has a new mark — the **Forge Caret** (`assets/grammarforge-mark.svg`,
mono + PNG variants). Full spec in `LOGO.md`. Retire the old pencil-in-a-lozenge
everywhere. Concrete tasks:
- Replace `clients/browser/public/icon/{16,32,48,96,128}.png` with the shipped
  `assets/icon/*.png` (mark on the dark tile).
- Use the full-color SVG + Space Grotesk wordmark in the popup/options header and
  the Vencord panel header.
- OpenCode: the CLI lockup (`❯ ` + mono mark) or the mono mark tinted to the
  prompt foreground.

## What to build (parity across all clients)
1. Adopt the Legion tokens + glass into each client's stylesheet/shadow root.
2. Underlines: always visible; **background tint only on hover or active card**
   (`.is-on`). Never a permanent background.
3. Hover a word → diff-only **preview pill** above it.
4. Click a word → **correction card**: diff, message, confidence bar, model source
   chip (Harper/GECToR "· instant", LLM "✨ AI"), alternatives, add-to-dictionary
   (spelling), `‹ N of M ›` nav, keyboard (Enter accept, ←/→ nav, Esc close).
5. **Review panel**: score ring + band, insights (tone / readability / words /
   read-time), category stripe, bulk actions (Accept-all, **high-confidence
   only**, per-category), grouped corrections, footer disable.
6. **Goals** popover (audience / formality / domain); `formality=informal` mutes
   style suggestions + seeds rephrase tone.
7. **Stats** tab: words/week, acceptance rate, streak, top-issue bars, dictionary
   manager (list + remove).
8. **Rephrase**: scope (sentence / whole message) + tone + streaming skeleton +
   regenerate; applies with Undo.
9. **Synonyms** on double-click of a clean word.
10. **Streaming**: render fast Harper/GECToR underlines immediately, then let the
    LLM pass settle in (pip → count, scan line, "AI refining…").
11. Every mutating action shows a **toast with Undo**; dismiss fires
    `/signal {action:'rejected'}` (the learning loop).
12. Per-site **disable** (orb → power glyph, paused panel empty-state).
13. **OpenCode**: keyboard-first review — `ctrl+g` next issue / `ctrl+shift+g`
    prev, `ctrl+n`/`ctrl+p` cycle, wrap (don't truncate) the rephrase card. Full
    spec in `opencode-interaction.md`.

## Wiring rules
- Pull all data from the existing bridge client (`/correct`, `/correct/stream`,
  `/rephrase`, `/signal`, `/dictionary`, `/health`, `/stats`). The reference
  prototypes fake this with local rules — replace that with the real calls.
- **Vencord**: do NOT rebuild `orchestrator.ts` — it already does field
  attach/detach, click hit-testing, hover, blur/paste, hotkeys, and the highlight
  layer. Re-skin the overlay to the Legion system and add the panel features.
  Apply edits via `applySlateFix` — never touch the live editor's `innerHTML`.
- **OpenCode**: keep every existing guard (seq, ref-swap, stale-pin, part
  ranges). Re-skin the card/status to Legion; make the changes in
  `opencode-interaction.md §8`.
- **Browser**: re-skin the overlay modules, add a panel component, and extend the
  settings form (goals defaults, hotkeys, rephrase prefs, dictionary manager,
  blocked sites).

## Two gotchas (don't skip)
- **Measure before re-render.** When an overlay rebuilds its DOM imperatively,
  measure the hovered/clicked word's rect BEFORE the rebuild — a detached node's
  `getBoundingClientRect()` is all zeros and the pill/card lands off-screen.
- **Entrance animations animate transform only, never opacity**, and surfaces are
  `opacity:1` by default (reduced-motion must not strand a popover invisible).

## Definition of done
The acceptance checklist in `INSTRUCTIONS.md §F`, behavior matching the reference
prototypes, both browser themes + Vencord dark + the user's terminal theme in
OpenCode, host chrome untouched, the new mark shipped, and all GF colors sourced
from Legion tokens. Keep diffs scoped; preserve the existing bridge/config/test
surface area.
