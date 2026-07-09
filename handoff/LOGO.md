# GrammarForge — Logo & Mark

GrammarForge is a product built **with** Legion Works, so its mark is a *sibling*
of the Legion aperture mark — same molten-cyan core, same glow, same restraint —
not a copy of it. This is the product's own identity.

## The mark: the Forge Caret

A single glyph carrying both halves of the name:

- **Grammar** — the proofreader's insertion **caret** (`‸`), which is also the
  terminal prompt caret (`^`). Universal shorthand for "edit this text."
- **Forge** — the caret's apex is a **molten core**: a white-hot cyan bead with a
  Gaussian glow, the exact core+glow language of the Legion mark. A correction is
  minted here, white-hot.
- The caret rests on the product's **signature baseline**: four short underline
  ticks in the exact issue-category colors (spelling · grammar · punctuation ·
  style). Two tiny **amber embers** rise off the core — the system's one warm
  touch.

## Files (ship these)

```
assets/
├── grammarforge-mark.svg        ← full color. Primary. 48×48 viewBox, scalable.
├── grammarforge-mark-mono.svg   ← single color via `currentColor`. For one-color
│                                   contexts (terminal, print, watermarks).
└── icon/                        ← rasterized app/extension icons on the dark tile
    ├── 16.png  32.png  48.png  96.png  128.png
```

The SVGs are the source of truth; the PNGs are generated from `grammarforge-mark.svg`
composited on the app-icon tile (below). Regenerate PNGs if the SVG changes.

## Anatomy & geometry (`viewBox 0 0 48 48`)

| Part | Geometry | Color |
|---|---|---|
| **Caret** | polyline `M12.5 28.5 L24 14 L35.5 28.5`, stroke 4.4, round caps/joins, `url(#gfCaret)` + glow filter | vertical gradient `#c7f2ff → #86e1fc → #82aaff` |
| **Molten core** | circle `cx24 cy14 r3.5` at the caret apex, + a 0.8px `#e6faff` inner ring @ 0.7 | radial `#e8faff → #86e1fc → #82aaff` + Gaussian glow (`stdDeviation 1.9`) |
| **Embers** | circles at `(29.4, 9.1) r1.15` and `(20.6, 7.9) r0.85` | radial amber `#ffe6cf → #ffc777 → #ff966c` |
| **Category baseline** | 4 ticks, stroke 2.6, round caps, `y=37.5`, from x≈12.5→35.5 | `#ef4444` · `#eab308` · `#06b6d4` · `#8b5cf6` |

The mark is **theme-invariant** — the gradient/glow read on any ground. Do not
recolor it per light/dark theme (only the *wordmark text* beside it follows the
theme).

## Variants

- **Full color** (`grammarforge-mark.svg`) — default everywhere it can render in
  color: app icon, panel headers, popup header, marketing.
- **Monochrome** (`grammarforge-mark-mono.svg`) — inherits `currentColor`
  (caret + core solid, baseline at 0.5 opacity). Use where a single color is
  required. In the terminal, set it to the prompt's foreground.
- **Terminal lockup** — the mono mark at 22–26px preceded by a cyan `❯`, e.g.
  `❯ grammarforge`.

## Clearspace & minimum size

- **Clearspace:** keep padding ≥ 25% of the mark's height on all sides. On the
  app tile the mark occupies ~64% of the tile.
- **Minimum size:** legible to **16px** (favicon / toolbar). Below ~24px the
  embers and baseline ticks visually merge — that's expected; the caret + core
  still read. Never render below 16px.

## App-icon tile

The mark is presented on a **deep-navy squircle**, never a cyan lozenge:

```
background: linear-gradient(158deg, #2a2f45 0%, #16161e 100%);
border-radius: 22% of size;          /* squircle feel */
border: 1px solid rgba(255,255,255,0.10);
/* subtle cyan bloom top-left + faint amber bloom bottom-right */
overlay: radial-gradient(58% 52% at 28% 18%, rgba(134,225,252,0.30), transparent 70%),
         radial-gradient(52% 48% at 84% 92%, rgba(255,150,108,0.18), transparent 70%);
box-shadow: 0 0 44px rgba(134,225,252,0.22);   /* optional glow for large sizes */
mark size: ~64% of the tile, centered.
```

## Lockups

- **Horizontal (primary):** mark + wordmark, gap 13px, wordmark in **Space
  Grotesk 600, letter-spacing −0.02em**. Wordmark is two-tone: `Grammar` in
  `--text-strong`, `Forge` in `--accent` (cyan). Mark ≈ 1× the cap height.
- **Stacked:** mark over wordmark, centered — for square/narrow slots.
- **CLI / mono:** `❯` + mono mark + `grammarforge` (JetBrains Mono 600) — for
  terminal chrome, READMEs, the OpenCode plugin.

## Do / Don't

- **Do** keep the mark on a dark or neutral ground; keep the molten core the
  brightest point.
- **Do** pair it with the Space Grotesk wordmark (never a different typeface).
- **Don't** put the mark on a cyan/blue fill (the core disappears).
- **Don't** recolor the caret to a flat single hue, drop the glow, or rebuild the
  old pencil-in-a-lozenge — that mark is retired.
- **Don't** stretch, rotate, add a drop shadow to the glyph itself, or reorder
  the baseline colors (the order encodes the category legend).

## Where each surface uses it

| Surface | Usage |
|---|---|
| **Browser extension** — toolbar/store icon | `public/icon/{16,32,48,96,128}.png` (mark on dark tile). Replace the existing pencil PNGs with the shipped ones. |
| **Browser extension** — popup + options header | full-color SVG @ 24–30px + horizontal wordmark lockup. |
| **Browser extension** — in-page score orb | the orb is NOT the logo — it's a score ring. Keep them distinct. |
| **Vencord** — panel header | full-color SVG @ 24px + "GrammarForge" (Space Grotesk). |
| **OpenCode** — plugin banner / status | CLI lockup `❯ ` + mono mark, or just the mono mark tinted to the prompt fg. |
| **Web / favicon** | `grammarforge-mark.svg` (browsers rasterize) or `icon/32.png`. |

See `GrammarForge Brand.dc.html` (project root) for the live brand sheet with all
of the above rendered, plus two alternate directions that were considered.

## Exact SVG source

Both files are in `assets/`. The full-color mark, for reference:

```svg
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gfCaret" x1="24" y1="12" x2="24" y2="30" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#c7f2ff"/><stop offset="55%" stop-color="#86e1fc"/><stop offset="100%" stop-color="#82aaff"/>
    </linearGradient>
    <radialGradient id="gfCore" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#e8faff"/><stop offset="55%" stop-color="#86e1fc"/><stop offset="100%" stop-color="#82aaff"/>
    </radialGradient>
    <radialGradient id="gfEmber" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="#ffe6cf"/><stop offset="60%" stop-color="#ffc777"/><stop offset="100%" stop-color="#ff966c"/>
    </radialGradient>
    <filter id="gfGlow" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="1.9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g stroke-width="2.6" stroke-linecap="round">
    <line x1="12.5" y1="37.5" x2="16.75" y2="37.5" stroke="#ef4444"/>
    <line x1="18.75" y1="37.5" x2="23" y2="37.5" stroke="#eab308"/>
    <line x1="25" y1="37.5" x2="29.25" y2="37.5" stroke="#06b6d4"/>
    <line x1="31.25" y1="37.5" x2="35.5" y2="37.5" stroke="#8b5cf6"/>
  </g>
  <path d="M12.5 28.5 L24 14 L35.5 28.5" fill="none" stroke="url(#gfCaret)" stroke-width="4.4"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#gfGlow)"/>
  <circle cx="29.4" cy="9.1" r="1.15" fill="url(#gfEmber)" opacity="0.92"/>
  <circle cx="20.6" cy="7.9" r="0.85" fill="url(#gfEmber)" opacity="0.85"/>
  <circle cx="24" cy="14" r="3.5" fill="url(#gfCore)" filter="url(#gfGlow)"/>
  <circle cx="24" cy="14" r="3.5" fill="none" stroke="#e6faff" stroke-width="0.8" opacity="0.7"/>
</svg>
```
