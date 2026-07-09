# GrammarForge — Design Handoff (Legion Works edition)

A self-hosted, privacy-first writing assistant. This pack is the design +
behavior spec for implementing GrammarForge across all three clients on one
unified visual language — the **Legion Works Design System** — plus its new
brand mark.

> **For the implementer (Cowok):** the HTML files in `reference/` are **design
> references** — clickable prototypes showing the intended look and behavior,
> not production code to paste. Your job is to reproduce them in the real
> codebase (`grammar-forge/clients/*`, TypeScript) using its existing patterns
> and the live bridge. Start with **HANDOFF_PROMPT.md**, then **INSTRUCTIONS.md**.

## Fidelity: high

The references are hi-fi — final colors, type, spacing, motion, and interaction.
Match them pixel-for-pixel using the codebase's libraries. Exact token values are
in `scss/_tokens.scss`; the mark is specified in `LOGO.md`.

## What's inside
```
handoff/
├── README.md              ← you are here
├── HANDOFF_PROMPT.md      ← paste this to your coding agent to kick off
├── INSTRUCTIONS.md        ← step-by-step, mapped to real codebase files
├── LOGO.md                ← the new GrammarForge mark: spec, variants, usage
├── flows.md               ← every interaction + state flow (browser + Vencord)
├── opencode-interaction.md← the OpenCode TUI keyboard/mouse interaction spec
├── markup.html            ← canonical DOM for the floating surfaces
├── assets/
│   ├── grammarforge-mark.svg       ← primary mark (full color)
│   ├── grammarforge-mark-mono.svg  ← one-color (currentColor)
│   └── icon/16,32,48,96,128.png    ← extension icons (drop into public/icon/)
├── scss/
│   ├── _tokens.scss       ← colors, type, radii, spacing, motion (Legion-based)
│   ├── _glass.scss        ← Liquid Glass mixins (light + dark, specular rim)
│   └── components.scss    ← card, panel, pill, underline, toast, rephrase, orb…
└── reference/             ← the 5 working prototypes + the DS they load
    ├── GrammarForge Assistant.dc.html   (browser extension — light + dark)
    ├── GrammarForge Vencord.dc.html      (Discord plugin — live composer)
    ├── GrammarForge OpenCode.dc.html     (terminal TUI plugin)
    ├── GrammarForge Prototypes.dc.html   (popup + in-page overlay showcase)
    └── GrammarForge Brand.dc.html        (the brand/mark sheet)
```
Open any `reference/*.dc.html` in a browser to click through real behavior.

## The design language

GrammarForge is now a **Legion Works** product. Everything visual descends from
that system (Tokyo Night based):

- **Accent is Legion Cyan** `#86E1FC` (dark) / `#2F7D9C` (light) — *not* the old
  blue `#2563eb`. Cyan is light, so primary buttons use **dark ink** `#0C1622`,
  never white.
- **Type:** Space Grotesk (wordmark/headings), Geist (UI/body), JetBrains Mono
  (all machine data) — not system-ui.
- **Surfaces:** Liquid Glass — translucent navy (dark) / white (light) panels,
  22px blur, hairline stroke, a specular rim (`--glass-rim`), floating over the
  aurora field.
- **One warm touch:** IceTea Amber `#FF966C`, used sparingly (e.g. the mark's
  embers). Never co-equal with cyan.
- **New mark:** the **Forge Caret** — see `LOGO.md`. Replaces the retired pencil
  lozenge everywhere.

**What did NOT change:** the functional **category** palette (spelling `#ef4444`,
grammar `#eab308`, punctuation `#06b6d4`, style `#8b5cf6`) and **score bands** —
these are editorial semantics, identical to before and now shared design-system
tokens (`--cat-*`, `--band-*`). Keep `api/category.ts` `CATEGORY_META` aligned to
them.

**Host chrome stays native.** Discord keeps its blurple, the browser page keeps
its look, the terminal keeps the user's theme — only the GrammarForge surfaces
floating on top carry the Legion language.

## The three clients
- `clients/browser/` — WXT + React extension (content overlay, popup, options).
- `clients/vencord/` — Vencord userplugin augmenting the Discord composer.
- `clients/opencode/` — OpenCode TUI plugin (keyboard-first prompt overlay).

All talk to the local bridge: `/correct`, `/correct/stream`, `/rephrase`,
`/signal`, `/dictionary`, `/health`, `/stats`.

## Feature surface (unchanged from the redesign; only the skin + mark moved)
Score orb, hover preview pill, correction card (model provenance, confidence,
alternatives, nav, keyboard), review panel (score ring, insights, bulk actions,
grouped list), Goals, Stats + dictionary manager, Rephrase, synonyms, the
visible fast→slow streaming, the learning loop (dismiss → `/signal` + undo
toasts), per-site disable. The OpenCode client adds the keyboard-first review
model in `opencode-interaction.md`.
