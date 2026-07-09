# GrammarForge — Implementation Instructions

How to land this design on the real codebase. Paths are relative to repo root.
The prototypes in `handoff/reference/` are the source of truth for visuals +
behavior; this file maps them onto the actual clients.

> The reference prototypes use plain-JS detection rules to fake the bridge so
> they run standalone. In the real clients, **keep the existing bridge calls** —
> the UI layer + the new visual language is what you're porting.

---

## A. Adopt the Legion Works design system (do this first)

GrammarForge is now a **Legion Works** product. Every GF surface pulls its
color / type / spacing / radius / glass from that system. Two ways to consume it
— pick one per client:

1. **Preferred — use the DS custom properties.** Inject the Legion token CSS into
   each GF root (the design system ships `tokens/*.css`; the values you need are
   `--accent`, `--accent-ink`, `--text-*`, `--bg-*`, `--border*`, `--ring`,
   `--glass-*`, `--glass-rim`, `--cat-*`, `--band-*`, `--font-*`). Then style with
   `var(--*)`. This themes automatically:
   - **dark** (default, Tokyo Night),
   - **light** — set `data-theme="light"` on the GF root,
   - **nightowl** — `data-theme="nightowl"`.
   For a shadow-root client, paste the `:root{…}` custom-property block into the
   shadow stylesheet so the vars resolve inside the shadow tree.

2. **Portable — compile the SCSS.** `scss/_tokens.scss` + `_glass.scss` +
   `components.scss` mirror the exact DS values as Sass. Compile and inline the
   CSS. `_tokens.scss` documents the `var(--*)` each Sass var maps to.

**Theme flag.** Set the theme on the GF root: browser follows the page/OS
preference (prototype exposes a Light/Dark toggle); **Vencord** is always dark;
**OpenCode** inherits the user's terminal theme (see §D).

**The big deltas from the old blue skin — check every surface:**
- Accent blue `#2563eb` → **Legion Cyan** `var(--accent)` (`#86E1FC` dark /
  `#2F7D9C` light). Hover → `var(--accent-strong)`.
- Primary-button text was white → now **dark ink** `var(--accent-ink)` (`#0C1622`
  on dark). White text on cyan is illegible — this is the #1 thing to get right.
- `system-ui` → `var(--font-ui)` (Geist) for UI, `var(--font-display)` (Space
  Grotesk) for the wordmark/headings, `var(--font-mono)` (JetBrains Mono) for all
  counts/versions/timestamps/keys.
- AI/rephrase violet `#8b5cf6` → **Geth Purple** `var(--purple-400)` `#C099FF`.
- Glass recipe → the Legion recipe (`_glass.scss`): translucent navy/white +
  `blur(22px) saturate(160%)` + hairline stroke + `--glass-rim` specular inset.

**Token discipline:** every GF surface pulls from tokens. Host chrome (Discord
blurple `#5865f2`, server rail, avatars, the page, the terminal theme) is
explicitly NOT in the system — leave it host-native.

**Categories stay put.** `--cat-*` / `--band-*` equal the old values. Keep
`api/category.ts` `CATEGORY_META` aligned to `_tokens.scss` `$gf-categories`.

## B. The new brand mark (see LOGO.md)

Retire the pencil-in-a-lozenge everywhere; ship the **Forge Caret**.

- **Extension icons:** replace `clients/browser/public/icon/{16,32,48,96,128}.png`
  with `handoff/assets/icon/*.png` (the mark rasterized on the dark tile). The
  manifest already points at these paths (`wxt.config.ts`).
- **Popup / options header** (`entrypoints/popup`, `entrypoints/settings`): full-
  color `grammarforge-mark.svg` @ 24–30px + the horizontal wordmark lockup
  (`Grammar` in `--text-strong`, `Forge` in `--accent`, Space Grotesk 600).
- **Vencord panel header:** same lockup @ 24px.
- **OpenCode:** the CLI lockup `❯ ` + `grammarforge-mark-mono.svg` (or just the
  mono mark tinted to the prompt foreground).
- Do NOT reuse the mark as the in-page score orb — the orb is a score ring, a
  distinct element. Keep them separate.

## C. Browser extension (WXT + React, `clients/browser/`)

| Surface | File | Change |
|---|---|---|
| Underline layer | `overlay/highlight.ts` | Keep the range→rect highlight; ensure **tint only on hover/active** (`.is-on`), underline always on. Recolor to `--cat-*`. |
| Status entry | `overlay/status-button.ts` | Replace with the **score orb** (ring + count/✓/power/AI-pip states), arc color = band. Click → panel. |
| Per-issue popover | `overlay/popover.ts` | Re-skin to `.gf-card` (Legion glass); add **alternatives**, **nav (‹ N of M ›)**, keyboard, confidence bar, source chip. Keep `onAddToDictionary`. |
| Review panel | new `overlay/panel.tsx` | Build per `markup.html §4`: score ring, insights, bulk actions (incl. **high-confidence**), grouped list, Goals popover, **Stats** tab, footer disable. |
| Rephrase | `overlay/` (new card) | `markup.html §5`: scope + tone + skeleton + regenerate, calling `api/client.ts → /rephrase`. Accent chips = `--purple-400`. |
| Hover pill | new | `.gf-tip`, diff-only. Measure-before-rerender (§E). |
| Popup | `entrypoints/popup/App.tsx` | New mark + wordmark; align Status/Settings tabs to Legion tokens; bridge health, per-site pause, category legend. |
| Settings | `entrypoints/settings/SettingsForm.tsx` | Add: Goals defaults, hotkeys, rephrase tone/style, dictionary manager (list+remove), blocked sites. |
| Icons | `public/icon/*.png` | Replace with the shipped mark PNGs (§B). |

Data comes from `api/client.ts` + `api/types.ts`. Use `CATEGORY_META`
(`api/category.ts`) as the single category source — align its colors to
`_tokens.scss`.

## D. Vencord plugin (`clients/vencord/`)

The orchestrator already implements the hard parts — **don't rebuild them**,
re-skin + extend:
- `orchestrator.ts` already has field attach/detach, click hit-test
  (`onFieldClick` → `openPopoverFor`), hover tooltip (`onFieldMouseMove`),
  blur/paste, accept/rephrase hotkeys, and the highlight layer. Keep all of it.
- Re-skin the overlay (popover, status button, styles) to the Legion system;
  they're structurally shared with the browser overlay.
- Add the panel features (insights, Goals, Stats, high-confidence) to the Vencord
  pill panel; add the new mark to its header.
- Composer is contenteditable/Slate — apply edits through the existing
  `applySlateFix(...)`; never `innerHTML` the live editor.
- Keep the hover tooltip **diff-only**. Vencord root is always `data-theme` dark.
- Host chrome (Discord blurple, server rail) stays native.

## E. OpenCode TUI plugin (`clients/opencode/`)

Keyboard-first prompt overlay. The full interaction spec — states, keymap, mouse
accelerators, the rephrase-card wrap fix, the status line — is in
**`opencode-interaction.md`**; its `§8` is the implementation checklist. Visual
notes:
- The overlay renders in the terminal, so it inherits the **user's terminal
  theme**, not web glass. Match the Legion OpenCode theme colors: accent =
  the theme's cyan, category underlines = `--cat-*` mapped to the nearest ANSI,
  diff old/new = red/green. `card-spec.ts` / `details-panel.ts` own the card
  view-model.
- Use the mono mark / CLI lockup for any banner (§B). No blur/glass in a TUI —
  the "glass" equivalent is a bordered card with the theme's raised background.
- Keep every existing guard (seq, ref-swap, stale-pin, part ranges).

## F. The one non-obvious bug to avoid (hover pill)

When you re-render the underline overlay imperatively, **measure the hovered/
clicked word's rect BEFORE the re-render**. Re-rendering detaches the old span
node; `getBoundingClientRect()` on a detached node returns zeros, so the pill/
card is positioned off-screen. Pattern:

```js
const hit = hitTest(rects, x, y);
let pos = null;
if (hit) pos = measure(hit.span);   // measure FIRST
renderUnderlay();                   // then rebuild
setState({ focusId: hit?.id, pos });
```
(The React/browser path avoids this by re-rendering declaratively, but any
imperative overlay — the Vencord/OpenCode underlay mirrors — must follow this.)

## G. Entrance animations

Entrance keyframes animate **transform only, never opacity**, and surfaces are
`opacity:1` by default. A reduced-motion or non-animating context must not strand
a popover at `opacity:0`. (See `components.scss` keyframes.)

## H. Acceptance checklist

- [ ] Every GF surface uses Legion tokens: accent = cyan, primary-button text =
      **dark ink** (never white), fonts = Space Grotesk / Geist / JetBrains Mono.
- [ ] Glass = the Legion recipe (translucent + 22px blur + hairline + `--glass-rim`);
      opaque `--bg-raised` for any dense/reading surface.
- [ ] New **Forge Caret** mark everywhere the pencil was; extension `public/icon/`
      PNGs replaced; popup/Vencord headers use the wordmark lockup.
- [ ] Underline always visible; background tint only on hover/active.
- [ ] Hover pill appears above the word with the diff (no buttons).
- [ ] Click → card at the word; alternatives, dictionary (spelling), nav,
      keyboard all work; source chip shows instant vs. ✨ AI.
- [ ] Panel: score ring + band, insights, Accept-all, high-confidence, grouped
      list, Goals (informal mutes style + note), Review/Stats tabs, dictionary
      manager.
- [ ] Rephrase: scope + tone + loading + regenerate; applies + Undo; chips purple.
- [ ] Synonym on double-click of a clean word.
- [ ] Streaming: fast underlines, then AI settle (pip → count; scan line).
- [ ] Every mutating action shows a toast with Undo; dismiss fires `/signal`.
- [ ] Disable-on-site path (orb power glyph + paused panel).
- [ ] Browser light **and** dark; Vencord dark; OpenCode inherits terminal theme.
      Host chrome untouched.
- [ ] OpenCode: `ctrl+g`/`ctrl+shift+g` review jump, `ctrl+n`/`ctrl+p` cycle,
      rephrase card **wraps** (never truncates) — per `opencode-interaction.md §8`.
- [ ] All GF colors come from tokens; categories match `CATEGORY_META`.
