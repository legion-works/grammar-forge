# Legion Works — Design System

The personal design system for **IceTea / Legion Works** and its AI system, **Legion (The Geth Collective)**. It covers web assets, light + dark themes, a full color system, reusable UI components, five product surfaces, and a terminal/TUI design system spanning **Ghostty** and **OpenCode** themes.

> The core idea is a **duality** grounded in the owner's OpenCode themes (Tokyo Night / Night Owl): the cool synthetic mind (Legion / Geth) in **Legion Cyan** `#86E1FC` and **Signal Blue** `#82AAFF` over a deep navy night, balanced by the warm hand of **IceTea Amber** `#FF966C`, used sparingly. The signature surface is **Liquid Glass** — translucent, blurred, refractive panels floating over an aurora field, with subtle, tasteful motion (slow aurora drift, quick fades — never bounce).

> **Vibe:** clean, precise, useful. Machine-grade but never campy. No "vibe-coded" clutter.

---

## Sources

- **GitHub org:** https://github.com/iceteaSA (connected). A mix of infrastructure daemons (`dormant`, `unifi-fan-control`, `unifi-ptz-better-patrol`, `HyperTizen`), OpenCode/Pi auth packages (`anthropic-auth`, `openai-auth`, `antigravity-auth`), and an `opencode` fork. Read at build time for the owner's **writing voice**, not visuals: terse, technical, confident; analogy-led openings; punchy declarative taglines ("Increase productivity. Decrease token usage.").
- **The OpenCode terminal theme is the foundation.** The owner currently runs **Tokyo Night** and **Night Owl** in OpenCode (`iceteaSA/opencode`). This design system is **re-based on Tokyo Night** (with Night Owl as a sibling `[data-theme="nightowl"]`): web tokens, the ANSI palette, the Ghostty theme, and the Legion OpenCode theme all share one palette. Legion Cyan = Tokyo Night cyan `#86E1FC`; Signal Blue = `#82AAFF`; Geth Purple = `#C099FF`; IceTea Amber = `#FF966C`/`#FFC777`. The neutral ramp is Tokyo Night's `darkStep1–12`; the base is extended *downward* into a deeper navy (`#16161E`) so Liquid Glass has real depth. Light mode follows Tokyo Night Day. The two source themes are vendored for reference at `themes/opencode/reference/`.
- **Logo / marks are original** to this brand, generated for Legion Works (the owner authorized generated marks). No third-party mark was reproduced.
- **Legion / The Geth Collective** is the owner's personal name for their AI setup; it is treated here as the identity of the design system's AI-facing surfaces.
- **GrammarForge** (`iceteaSA/grammar-forge`, private) already ships a Liquid Glass UI — validating this system's direction. Only the **functional** parts were adopted: the grammar-category + quality-band color scales (now `tokens/annotations.css`) and the specular-rim glass recipe (`--glass-rim`). Its louder/blue accent and campier flourishes were **not** carried over; the popup is recreated in the restrained Legion glass instead.
- **Domains:** `legionworks.dev` (Legion / product surfaces) and `iceteasa.dev` (the owner's personal site). Use `legionworks.dev` on Legion product UI; `iceteasa.dev` for personal/portfolio contexts.

---

## Content Fundamentals

**Voice.** Terse, technical, quietly confident. Legion speaks like a competent machine that respects your time — declarative, never chatty, never salesy. Prefer the imperative and the present tense.

**Person.** Address the user as **you**; the system refers to itself as **Legion** or **we** (the Collective is plural — "We are Legion"). Avoid "I".

**Casing.** Sentence case for UI and prose. **UPPERCASE + wide tracking** is reserved for eyebrows, labels, and status chips (`SYNTHESIS`, `ONLINE`, `v2.4`). Never all-caps a full sentence.

**Numbers & data.** Monospace for anything countable — versions, timestamps, metrics, keybindings, hashes. This is a load-bearing habit, not decoration: mono = machine-truth.

**Examples**
- Button: `Initialize`, `Run synthesis`, `Dismiss` (verbs, one or two words)
- Empty state: `No processes. Legion is idle.`
- Eyebrow: `THE GETH COLLECTIVE`
- Error: `Consensus failed. 3 of 12 units disagreed.` (plain, specific, no blame)
- Tagline energy: `Many programs. One consensus.`

**Emoji.** Not used in product UI. Status is shown with color + glyph (a dot, a chevron), never 🎉. Emoji may appear only in incidental human contexts (a blog byline) and even then, rarely.

**No filler.** No lorem, no dummy stats, no decorative iconography that doesn't inform. One thousand no's for every yes.

---

## Visual Foundations

**Color.** Tokyo Night-based (grounded in the owner's OpenCode themes). Deep-navy ground (`--bg-base` #16161E dark / Tokyo Day #E6E7ED light). Primary accent **Legion Cyan** (`--accent`, #86E1FC dark / #2F7D9C light). Warm counter-accent **IceTea Amber** (`--accent-warm`, #FF966C) — one human touch per view, never co-equal. **Signal Blue** #82AAFF for links/focus; **Geth Purple** #C099FF as a tertiary synthetic accent. Neutrals are Tokyo Night's blue-grays (`darkStep1–12`). Semantic: green #C3E88D, warning yellow #FFC777, danger red #FF757F, info cyan. The ANSI-16 palette in `tokens/ansi.css` is canonical Tokyo Night and drives Ghostty + OpenCode + TUI mocks in lockstep. A `[data-theme="nightowl"]` sibling retints everything to Night Owl (#011627 ground, #7FDBCA cyan).

**Type.** Display **Space Grotesk** (technical geometric, headings + wordmark). UI/body **Geist** (clean neo-grotesk — precise, neutral, not Inter). Mono **JetBrains Mono** for all machine data, code, and terminal. Minor-third scale, base 16px. Tight tracking on display; wide caps tracking on eyebrows.

**Spacing.** 4px base grid, t-shirt-named steps. Generous — the system breathes; density is reserved for terminal/data contexts.

**Backgrounds.** The default is the **aurora/mesh field** (`.lw-aurora`): cool cyan + blue radial blooms with one warm amber bloom low-right, over the base color. Glass panels float on this. No busy patterns, no photographic hero imagery by default; imagery, when present, is cool-toned, high-contrast, slightly desaturated. Never solid-flat behind glass — glass over solid reads as dead gray.

**Transparency & blur.** The core motif. `--glass-blur` 22px + `--glass-saturate` 160%, translucent white fill, a **hairline stroke**, and a **top specular highlight** (the "wet" glass edge) via `.lw-glass::before`. Use glass for: nav bars, cards, modals, popovers, the chat composer. Do NOT use glass for dense data tables or long-form reading surfaces — those get opaque `--bg-raised`.

**Elevation & shadow.** Cool, low-spread shadows (`--shadow-sm…xl`) plus an **accent glow** (`--glow-cyan` / `--glow-amber`) for focus and synthetic emphasis. Glass adds its own inner specular. Light mode softens shadows heavily.

**Corner radii.** 10px (`--radius-md`) is the workhorse for controls; 14px for cards; 20–28px for large glass surfaces and modals; pill for chips/toggles/keycaps. Terminal chrome uses the same rounding as the OS window (10–12px).

**Borders.** Hairline, low-alpha, neutral (`--border`), brightening to `--border-strong` on hover and `--border-accent` when active/selected. Accent borders never scream — they're a 45%-alpha cyan.

**Motion.** Quick and precise — `--dur-fast 120ms` / `--dur-mid 200ms`, soft ease-out (`--ease`), **no bounce, no overshoot**. Fades and short translates only. Two tasteful ambient touches: a very slow aurora drift (`.lw-aurora--drift`, 34s) and a fade-rise entrance (`.lw-enter`). Reduced-motion zeroes durations and disables both. Decorative infinite loops are otherwise avoided except the terminal cursor blink.

**Hover / press.** Hover: border brightens + fill lifts ~4% + optional faint glow. Press: fill darkens slightly and the element scales to 0.98 (`transform`), never a color flip. Focus: 2px `--ring` (cyan) outline, offset 2px.

**Layout rules.** Max content width 1200px; prose 68ch. Sticky glass header at 64px. Fixed elements (header, toasts) sit on glass so page content is visible refracting beneath.

---

## Iconography

- **Primary set: [Lucide](https://lucide.dev)** — the intended icon system, chosen for its precise 1.75px geometric stroke matching Space Grotesk + Geist. In the UI kits here, icons are drawn as **inline SVG in the Lucide style** (same 1.75 stroke, geometric construction) to keep the kits dependency-free; in production, load Lucide from CDN and use the named glyphs. This is a **flagged substitution** — no icon set was provided in sources.
- Usage: stroke icons only, `1.75` stroke width, sized to the text they sit beside (16 / 18 / 20 / 24). Never fill icons; never mix icon families.
- **Unicode/glyph accents** are used deliberately in terminal/TUI contexts: `▸ ▾ ● ○ ◆ › ⏻` and box-drawing `─ │ ┌ ┐ └ ┘` for TUI frames. These are part of the terminal vocabulary, not decoration.
- **Emoji:** not used as icons anywhere in product UI.
- No custom SVG illustration set exists yet (flagged — see Caveats).

---

## Index

**Foundations** — `styles.css` (root entry, `@import` list only) → `tokens/`:
`colors.css` · `ansi.css` · `annotations.css` · `typography.css` · `spacing.css` · `radius-shadow.css` · `glass.css` · `base.css` · `fonts.css`

**Specimen cards** (Design System tab): `guidelines/*.card.html` — groups Colors, Type, Spacing, Brand, Terminal. Plus each component/kit directory contributes a card.

**Components** — `components/<group>/` (`<Name>.jsx` + `.d.ts` + `.prompt.md`, one `*.card.html` per dir):
- `core/` — Button, IconButton, Card, GlassPanel, Badge, Tag
- `forms/` — Input, Textarea, Select, Checkbox, Radio (+RadioGroup), Switch
- `feedback/` — Toast, Tooltip, Progress, Spinner
- `navigation/` — Tabs
- `overlays/` — Dialog
- `terminal/` — TerminalWindow, StatusBar, Prompt, KeyCap

**UI Kits** — `ui_kits/<product>/index.html` (+ `.jsx`, `README.md`):
`landing` (legionworks.dev) · `legion-chat` · `docs` · `dashboard` · `blog` · `grammarforge`

**Terminal / Themes** — `themes/`:
`ghostty/legion` + `ghostty/legion-nightowl` (Ghostty configs) · `opencode/legion.json` (OpenCode theme) · `opencode/reference/` (stock Tokyo Night + Night Owl) · `README.md` (install).

**Assets** — `assets/logo/legion-mark.svg` (the consensus-aperture mark).

**Meta** — `readme.md` (this file) · `SKILL.md` (Agent Skill wrapper).

---

## Caveats

- **Fonts are loaded from Google Fonts / jsDelivr CDN, not vendored** into `/assets`. Fine for online use; self-host `@font-face` if you need offline. Geist comes from `geist` on jsDelivr.
- **Font choices are my picks, not confirmed.** Space Grotesk / Geist / JetBrains Mono match "clean, precise, useful" — say the word to swap.
- **Lucide icons are a flagged substitution** (no source set provided).
- **No logo** — an original **Legion mark** (consensus aperture: many nodes → one glowing core) was generated at `assets/logo/legion-mark.svg`, paired with a Space Grotesk wordmark. Original to this brand.
- **Theme is grounded in your real OpenCode themes** (Tokyo Night primary, Night Owl sibling). The Ghostty + Legion OpenCode theme files are derived from these; reconcile if you retune them.
