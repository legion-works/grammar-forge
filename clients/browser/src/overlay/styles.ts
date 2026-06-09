// Adapted from codextde/textchecker @ 7b66d78e74379f9fc909f6d4a2d984cb50a5d088 (MIT)
// Shadow-root CSS for the overlay. Implements the "Liquid Glass" material
// described in spec §7.1 + the Liquid Glass CSS research:
//
//   - Glass panel (popover) + glass pill (status) with backdrop-filter +
//     -webkit-backdrop-filter + saturate(). Default = near-opaque solid
//     scrim (legible over arbitrary pages); @supports upgrades to true glass.
//   - Dark scrim (~40% alpha) so text reads on any page background; text uses
//     light-dark() + a text-shadow belt-and-braces.
//   - Hairline border via color-mix, inset specular + outer drop shadow.
//   - isolation: isolate + contain: layout paint to bound backdrop-filter
//     sample region and reduce paint cost.
//   - Underline classes are CRISP per category (NOT glass) — wavy / dotted /
//     solid colors straight from CATEGORY_META. They render position:fixed
//     children of the shadow root.
//   - Appear animation: transform + opacity only (cubic-bezier(0.22,1,0.36,1)
//     out-back); never animate backdrop-filter.
//   - Accessibility: @media (prefers-reduced-transparency: reduce) strips the
//     blur and bumps the scrim to ~92% opaque; @media (prefers-reduced-motion:
//     reduce) drops the spring and keeps a short opacity fade only. Uses the
//     additive pattern (default solid, glass added under
//     prefers-reduced-transparency: no-preference).

const Z_OVERLAY = 2147483647

const SCALE_TOOLTIP = 0.96
const DURATION_TOOLTIP_MS = 180

export const OVERLAY_CSS = `
  :host,
  :host * {
    box-sizing: border-box;
  }
  :host {
    color-scheme: light dark;
    /* Text adapts automatically to OS scheme; in the overlay, the page sets
       the tone, but this keeps icons + scrim sane when the user is in
       dark mode themselves. */
    color: light-dark(#111, #f5f5f5);
    font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }

  /* ============================================================
   * Underline (CRISP, NOT glass) — one node per getClientRects() rect
   * ============================================================ */
  .gf-underline {
    position: fixed;
    /* Purely visual: hover/click interaction is detected on the FIELD itself
       (content orchestrator hit-tests the pointer against the edit rects), so
       the underline must NEVER intercept the page's mouse events — that keeps
       the field fully editable and selectable under the overlay. */
    pointer-events: none;
    /* height is set per-category; baseline 2px. */
    height: 2px;
    background: transparent;
    /* No transform on the static state — it would push fixed-position
       children off by 1 device pixel on some Android WebViews. */
    transform-origin: 50% 100%;
    z-index: ${Z_OVERLAY};
  }

  .gf-underline--wavy {
    /* Real spellchecker squiggle: a 6x3 SVG wave tiled horizontally.
       currentColor drives the stroke; the marker node sets style.color
       per category so the same SVG is red for spelling, amber for
       grammar, etc. The path is one full period of a sine (M Q T), so
       the tiling is seamless. */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3' viewBox='0 0 6 3'><path d='M0 2 Q 1.5 0 3 2 T 6 2' fill='none' stroke='currentColor' stroke-width='1' stroke-linecap='round'/></svg>");
    background-repeat: repeat-x;
    background-position: 0 100%;
    background-size: 6px 3px;
  }
  .gf-underline--dotted {
    background-image: radial-gradient(circle, currentColor 50%, transparent 50%);
    background-repeat: repeat-x;
    background-position: 0 100%;
    background-size: 3px 100%;
  }
  .gf-underline--solid {
    background: currentColor;
  }

  /* ============================================================
   * Glass panel (popover) — base = near-opaque solid scrim so the
   * popover reads on any page; @supports upgrades to true glass.
   * ============================================================ */
  .gf-panel {
    position: fixed;
    pointer-events: auto;
    z-index: ${Z_OVERLAY};
    min-width: 280px;
    max-width: 380px;
    padding: 12px 14px;
    border-radius: 14px;
    isolation: isolate;
    contain: layout paint;
    /* default solid scrim (dark on light pages) — text reads either way */
    background: rgba(28, 28, 30, 0.78);
    color: #f5f5f5;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.18),
      0 1px 2px rgba(0, 0, 0, 0.12),
      0 8px 24px rgba(0, 0, 0, 0.20);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    /* enter animation: transform+opacity only */
    transform-origin: 50% 100%;
    animation: gf-popover-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes gf-popover-enter {
    from { transform: scale(${SCALE_TOOLTIP}); opacity: 0; }
    to   { transform: scale(1);       opacity: 1; }
  }

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-panel {
      background: color-mix(in oklab, #1c1c1e 40%, transparent);
      border-color: color-mix(in oklab, white 14%, transparent);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      backdrop-filter: blur(16px) saturate(180%);
    }
  }

  /* ============================================================
   * Glass pill (status button) — same material, tighter blur, full radius
   * ============================================================ */
  .gf-pill {
    position: fixed;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
    z-index: ${Z_OVERLAY};
    padding: 4px 12px;
    border-radius: 9999px;
    isolation: isolate;
    contain: layout paint;
    font: 500 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: rgba(28, 28, 30, 0.78);
    color: #f5f5f5;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.18),
      0 1px 3px rgba(0, 0, 0, 0.14),
      0 4px 12px rgba(0, 0, 0, 0.10);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    cursor: pointer;
    transform-origin: 50% 100%;
    animation: gf-pill-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes gf-pill-enter {
    from { transform: scale(${SCALE_TOOLTIP}); opacity: 0; }
    to   { transform: scale(1);       opacity: 1; }
  }

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-pill {
      background: color-mix(in oklab, #1c1c1e 36%, transparent);
      border-color: color-mix(in oklab, white 12%, transparent);
      -webkit-backdrop-filter: blur(10px) saturate(160%);
      backdrop-filter: blur(10px) saturate(160%);
    }
  }

  /* Power button + body inside the pill */
  .gf-pill__power {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.08);
    color: #f5f5f5;
    cursor: pointer;
    flex: 0 0 auto;
    transition: background 120ms ease-out, color 120ms ease-out;
  }
  .gf-pill__power:hover {
    background: rgba(255, 255, 255, 0.18);
  }
  .gf-pill__power:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  .gf-pill__body {
    appearance: none;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
  }
  /* Collapsed (disabled-on-this-site) pill: just the muted power icon */
  .gf-pill--disabled {
    padding: 4px;
    opacity: 0.65;
  }
  .gf-pill--disabled .gf-pill__power {
    background: transparent;
    color: #9ca3af;
  }

  /* Pill hover panel — corrections list + Apply all (glass like the popover) */
  .gf-pill-panel {
    position: fixed;
    pointer-events: auto;
    z-index: ${Z_OVERLAY};
    min-width: 220px;
    max-width: 360px;
    padding: 8px;
    border-radius: 12px;
    isolation: isolate;
    contain: layout paint;
    background: rgba(28, 28, 30, 0.82);
    color: #f5f5f5;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.16),
      0 1px 2px rgba(0, 0, 0, 0.12),
      0 8px 24px rgba(0, 0, 0, 0.20);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    transform-origin: 50% 100%;
    animation: gf-popover-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-pill-panel {
      background: color-mix(in oklab, #1c1c1e 40%, transparent);
      border-color: color-mix(in oklab, white 14%, transparent);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      backdrop-filter: blur(16px) saturate(180%);
    }
  }
  .gf-pill-panel__header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
    margin: 2px 4px 6px;
  }
  .gf-pill-panel__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 240px;
    overflow-y: auto;
  }
  .gf-pill-panel__row {
    appearance: none;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 5px 8px;
    border-radius: 8px;
    cursor: pointer;
  }
  .gf-pill-panel__row:hover {
    background: rgba(255, 255, 255, 0.10);
  }
  .gf-pill-panel__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .gf-pill-panel__apply-all {
    appearance: none;
    width: 100%;
    margin-top: 8px;
    border: 1px solid #1d4ed8;
    background: #2563eb;
    color: #fff;
    font: inherit;
    font-weight: 600;
    font-size: 12px;
    padding: 7px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 120ms ease-out;
  }
  .gf-pill-panel__apply-all:hover {
    background: #1d4ed8;
  }
  .gf-pill-panel__apply-all:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }

  /* ============================================================
   * Hover tooltip — read-only preview (no buttons). Same glass material
   * as the pill, pointer-events:none so it never blocks the field.
   * ============================================================ */
  .gf-tooltip {
    position: fixed;
    pointer-events: none;
    z-index: ${Z_OVERLAY};
    max-width: 320px;
    padding: 8px 10px;
    border-radius: 10px;
    isolation: isolate;
    contain: layout paint;
    background: rgba(28, 28, 30, 0.82);
    color: #f5f5f5;
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.16),
      0 1px 3px rgba(0, 0, 0, 0.14),
      0 6px 18px rgba(0, 0, 0, 0.18);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    transform-origin: 50% 100%;
    animation: gf-pill-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-tooltip {
      background: color-mix(in oklab, #1c1c1e 38%, transparent);
      border-color: color-mix(in oklab, white 12%, transparent);
      -webkit-backdrop-filter: blur(10px) saturate(160%);
      backdrop-filter: blur(10px) saturate(160%);
    }
  }
  .gf-tooltip__header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 2px;
  }
  .gf-tooltip__dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex: 0 0 auto;
  }
  .gf-tooltip__label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .gf-tooltip__message {
    font-size: 12px;
    line-height: 1.35;
    margin: 2px 0;
  }
  .gf-tooltip__fix {
    font-size: 12px;
    margin: 2px 0;
  }
  .gf-tooltip__arrow {
    opacity: 0.7;
  }
  .gf-tooltip__replacement {
    font-weight: 600;
  }
  .gf-tooltip__hint {
    font-size: 10px;
    opacity: 0.6;
    margin-top: 3px;
  }

  /* ============================================================
   * Liquid-glass refractive RIM — an additive highlight ring (does not touch
   * the base box-shadow). Bright specular top edge + a hairline all around so
   * the panel edge reads as a glass lens. The backdrop displacement filter
   * (gf-glass-distortion, wired into backdrop-filter above) supplies the
   * refraction; this is the bright rim that sells it.
   * ============================================================ */
  .gf-panel::after,
  .gf-pill-panel::after,
  .gf-tooltip::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    /* Bright specular top edge + a faint refractive ring all around. */
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow:
      inset 0 1px 1.5px rgba(255, 255, 255, 0.5),
      inset 1px 0 1px rgba(255, 255, 255, 0.18),
      inset -1px 0 1px rgba(255, 255, 255, 0.18),
      inset 0 -1px 1px rgba(0, 0, 0, 0.18);
    /* Distort the rim itself (filter url() works on elements, unlike inside
       backdrop-filter) so the glass EDGE refracts/wobbles like real glass.
       Subtle on purpose — a strong scale turns the rim into noise. */
    -webkit-filter: url(#gf-glass-distortion);
    filter: url(#gf-glass-distortion);
  }

  /* ============================================================
   * Diff preview (shared by tooltip, popover, pill panel):
   * original word(s) red + struck-through  ->  corrected word(s) green
   * ============================================================ */
  .gf-diff {
    display: inline;
    font-size: 13px;
    word-break: break-word;
  }
  .gf-diff__old {
    color: #fca5a5;
    text-decoration: line-through;
    text-decoration-color: #ef4444;
  }
  .gf-diff__arrow {
    opacity: 0.7;
    margin: 0 2px;
  }
  .gf-diff__new {
    color: #86efac;
    font-weight: 600;
  }
  .gf-diff__removed {
    color: #9ca3af;
    font-style: italic;
  }
  .gf-panel__diff {
    margin: 4px 0 8px;
  }

  /* ============================================================
   * Popover internals
   * ============================================================ */
  .gf-panel__header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .gf-panel__dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
    flex: 0 0 auto;
  }
  .gf-panel__label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .gf-panel__message {
    font-size: 13px;
    line-height: 1.4;
    color: inherit;
    margin: 4px 0 8px;
  }
  .gf-panel__replacement {
    font-weight: 600;
    color: #f5f5f5;
  }
  .gf-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .gf-panel__btn {
    appearance: none;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 120ms ease-out, border-color 120ms ease-out;
  }
  .gf-panel__btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.30);
  }
  .gf-panel__btn:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  .gf-panel__btn--primary {
    background: #2563eb;
    border-color: #1d4ed8;
    color: #fff;
  }
  .gf-panel__btn--primary:hover {
    background: #1d4ed8;
    border-color: #1e40af;
  }
  .gf-panel__btn--ghost {
    background: transparent;
    border-color: transparent;
    color: rgba(245, 245, 245, 0.8);
  }
  .gf-panel__btn--ghost:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.08);
  }
  .gf-panel__alternatives {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.10);
  }
  .gf-panel__alternative {
    appearance: none;
    text-align: left;
    border: 1px solid rgba(255, 255, 255, 0.10);
    background: rgba(255, 255, 255, 0.04);
    color: inherit;
    font: inherit;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .gf-panel__alternative:hover {
    background: rgba(255, 255, 255, 0.10);
  }

  /* ============================================================
   * Reduced-transparency: drop the glass, bump scrim to ~92% opaque
   * ============================================================ */
  @media (prefers-reduced-transparency: reduce) {
    .gf-panel,
    .gf-pill,
    .gf-pill-panel,
    .gf-tooltip {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      background: color-mix(in oklab, #1c1c1e 92%, transparent);
      border-color: color-mix(in oklab, white 8%, transparent);
    }
  }

  /* Additive pattern: only add the glass where the user has explicitly
     opted into translucency. Browsers that don't implement the media
     query fall through to the @supports block above, which is the safe
     default. */
  @media (prefers-reduced-transparency: no-preference) {
    /* The base style is already solid; the @supports block above adds
       the glass upgrade. This rule exists as a forward-compatible hook
       for future tuning (e.g. theme-aware scrim direction). */
  }

  /* ============================================================
   * Reduced-motion: kill spring, keep a short opacity fade
   * ============================================================ */
  @media (prefers-reduced-motion: reduce) {
    .gf-panel,
    .gf-pill {
      animation-duration: 1ms;
      animation-name: gf-no-motion;
    }
    .gf-tooltip {
      animation-duration: 1ms;
      animation-name: gf-no-motion;
    }
  }
  @keyframes gf-no-motion {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
`
