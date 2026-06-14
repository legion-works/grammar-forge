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
//   - Highlight classes are translucent per category (NOT glass) — full-rect
//     rects tinted by a `--gf-hl` custom property, intensity flipped by
//     gf-highlight--focus / gf-highlight--hover modifier classes. They render
//     position:fixed children of the shadow root.
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
   * Highlight (the "issue" marker drawn over each flagged word).
   *
   * Migrated from the legacy .gf-highlight (full-rect permanent tint)
   * to the design-system .gf-u per the W1-1 task.
   * ============================================================ */
  .gf-u {
    position: fixed;
    /* Purely visual: hover/click interaction is detected on the FIELD itself
       (content orchestrator hit-tests the pointer against the edit rects), so
       the highlight must NEVER intercept the page's mouse events — that keeps
       the field fully editable and selectable under the overlay. */
    pointer-events: none;
    z-index: ${Z_OVERLAY};
    border-radius: 2px;
    background: transparent;
    border-bottom: 1.7px wavy var(--gf-hl, #888);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    transition: background 140ms ease-out;
  }
  .gf-u--spelling    { border-bottom-color: var(--gf-cat-spelling); }
  .gf-u--grammar     { border-bottom-color: var(--gf-cat-grammar); }
  .gf-u--punctuation { border-bottom-color: var(--gf-cat-punctuation); }
  .gf-u--style       { border-bottom-color: var(--gf-cat-style); }
  .gf-u--typography  { border-bottom-color: var(--gf-cat-typography); }
  .gf-u.is-on         { background: color-mix(in srgb, var(--gf-hl, #888) 22%, transparent); }
  .gf-u--spelling.is-on    { background: color-mix(in srgb, var(--gf-cat-spelling) 22%, transparent); }
  .gf-u--grammar.is-on     { background: color-mix(in srgb, var(--gf-cat-grammar) 22%, transparent); }
  .gf-u--punctuation.is-on { background: color-mix(in srgb, var(--gf-cat-punctuation) 22%, transparent); }
  .gf-u--style.is-on       { background: color-mix(in srgb, var(--gf-cat-style) 22%, transparent); }
  .gf-u--typography.is-on  { background: color-mix(in srgb, var(--gf-cat-typography) 22%, transparent); }

  /* Transient applied flourish: a quick fade and lift the moment a fix is
     applied, before the highlight reconciles away. Animation-only on a
     transient class removed on animationend, so it never sticks to a reused
     pooled node and never overrides the idle/focus/hover background. */
  .gf-u--applied {
    animation: gf-highlight-applied 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes gf-highlight-applied {
    from { transform: scale(1); opacity: 1; }
    60%  { transform: scale(1.08); opacity: 0.55; }
    to   { transform: scale(0.96); opacity: 0; }
  }

  @media (prefers-contrast: more) {
    .gf-u { border-bottom-width: 2.2px; }
    .gf-u.is-on { background: color-mix(in srgb, var(--gf-hl, #888) 40%, transparent); }
  }

  /* ============================================================
   * Glass panel (popover) — base = near-opaque solid scrim so the
   * popover reads on any page; @supports upgrades to true glass.
   * ============================================================ */
  .gf-panel {
    position: fixed;
    pointer-events: auto;
    z-index: ${Z_OVERLAY};
    /* When promoted to the top layer via popover=manual + showPopover(), the UA
       stylesheet applies inset:0 + margin:auto, which CENTERS the panel and
       overrides our explicit left/top (the popover opened over the pill, not the
       word). Reset both so our JS positionPanel() left/top wins. */
    margin: 0;
    inset: auto;
    min-width: 280px;
    max-width: 380px;
    padding: 12px 14px;
    border-radius: 14px;
    isolation: isolate;
    contain: layout paint;
    /* default solid scrim (dark on light pages) — text reads either way */
    background: rgba(28, 28, 30, 0.78);
    background: light-dark(rgba(245, 245, 245, 0.85), rgba(28, 28, 30, 0.78));
    color: light-dark(#111, #f5f5f5);
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
      background: light-dark(
        color-mix(in oklab, #f5f5f5 50%, transparent),
        color-mix(in oklab, #1c1c1e 40%, transparent)
      );
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
    background: light-dark(rgba(245, 245, 245, 0.78), rgba(28, 28, 30, 0.78));
    color: light-dark(#111, #f5f5f5);
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.18),
      0 1px 3px rgba(0, 0, 0, 0.14),
      0 4px 12px rgba(0, 0, 0, 0.10);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    cursor: pointer;
    /* Position is applied via transform: translate() (P3 — composited, no
       reflow on the scroll/resize loop). There is therefore NO enter-pop scale
       animation: a transform keyframe would clobber the position translate, and
       a filled opacity keyframe would persist its end value and override the
       faint idle opacity + the :hover lift. The pill simply appears. */
    /* Nearly transparent by default — the user opts in by hovering or dragging.
       Lifts fully on :hover / .gf-pill--dragging. */
    opacity: 0.1;
    transition: opacity 150ms ease-out, box-shadow 150ms ease-out;
  }
  .gf-pill:hover,
  .gf-pill.gf-pill--dragging {
    opacity: 1;
  }
  .gf-pill--dragging { cursor: grabbing; user-select: none; }
  /* Focus-only visibility: the active per-field pill is hidden while its field
     is unfocused. display:none so it neither paints nor intercepts pointer
     events; the orchestrator toggles this on field focus/blur. */
  .gf-pill--hidden { display: none; }

  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-pill {
      background: light-dark(
        color-mix(in oklab, #f5f5f5 50%, transparent),
        color-mix(in oklab, #1c1c1e 36%, transparent)
      );
      border-color: color-mix(in oklab, white 12%, transparent);
      -webkit-backdrop-filter: blur(10px) saturate(160%);
      backdrop-filter: blur(10px) saturate(160%);
    }
  }

  /* Power + recheck icon buttons + body inside the pill */
  .gf-pill__power,
  .gf-pill__recheck {
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
  .gf-pill__power:hover,
  .gf-pill__recheck:hover {
    background: rgba(255, 255, 255, 0.18);
  }
  .gf-pill__power:focus-visible,
  .gf-pill__recheck:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  .gf-pill__recheck:active svg {
    transform: rotate(180deg);
    transition: transform 200ms ease-out;
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
    font-variant-numeric: tabular-nums;
  }
  /* Compact count badge (replaces the "N issues · …" text; detail is in the
     toolbar popup). Red-tinted for issues, green for the clean state. */
  .gf-pill__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, #ef4444 22%, transparent);
    color: light-dark(#b91c1c, #fecaca);
  }
  .gf-pill__badge--ok {
    /* Clean state reads CALM, not a loud success banner: a fainter green wash
       and a muted green glyph. The pill itself is near-transparent at idle and
       lifts on hover, so the badge only needs to whisper "all clear". */
    background: color-mix(in srgb, #22c55e 14%, transparent);
    color: #4b9e6a;
  }
  .gf-pill-bar {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    width: 28px;
    height: 4px;
    margin-left: 2px;
    border-radius: 2px;
    overflow: hidden;
  }
  .gf-pill-bar__stripe {
    height: 4px;
    border-radius: 2px;
    opacity: 0.6;
    min-width: 3px;
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
    background: light-dark(rgba(245, 245, 245, 0.82), rgba(28, 28, 30, 0.82));
    color: light-dark(#111, #f5f5f5);
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
      background: light-dark(
        color-mix(in oklab, #f5f5f5 50%, transparent),
        color-mix(in oklab, #1c1c1e 40%, transparent)
      );
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

  /* Unified pill panel — action row (Apply all · Undo · Recheck · Rephrase ·
     Power). Glass-like chips, wrapping on narrow widths. */
  .gf-pill-panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px;
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }
  .gf-pill-panel__action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 8px;
    border: none;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    cursor: pointer;
  }
  .gf-pill-panel__action:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.18);
  }
  .gf-pill-panel__action:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Paused-site badge: a power-glyph <span> (not a button) sits inside the
     pill body — needs its inner <svg> to actually paint at full size. */
  .gf-pill__badge--power svg { display: block; }

  /* ============================================================
   * Hover tooltip — read-only preview (no buttons). Same glass material
   * as the pill, pointer-events:none so it never blocks the field.
   * ============================================================ */
  .gf-tooltip {
    position: fixed;
    pointer-events: none;
    z-index: ${Z_OVERLAY};
    max-width: 320px;
    padding: 4px 8px;
    border-radius: 10px;
    isolation: isolate;
    contain: layout paint;
    background: rgba(28, 28, 30, 0.82);
    background: light-dark(rgba(245, 245, 245, 0.82), rgba(28, 28, 30, 0.82));
    color: light-dark(#111, #f5f5f5);
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.16),
      0 1px 3px rgba(0, 0, 0, 0.14),
      0 6px 18px rgba(0, 0, 0, 0.18);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    transform-origin: 50% 100%;
    animation: gf-pill-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .gf-tooltip__chip-diff { font-size: 12px; white-space: nowrap; }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-tooltip {
      background: light-dark(
        color-mix(in oklab, #f5f5f5 50%, transparent),
        color-mix(in oklab, #1c1c1e 38%, transparent)
      );
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
   * Rephrase flow — entry button (.gf-rephrase-btn) + result card
   * (.gf-rephrase-card). Both use the same glass material as the
   * popover + pill; the card adds the Popover-API top-layer fix
   * (margin:0; inset:auto;) so our inline left/top wins.
   * ============================================================ */
  .gf-rephrase-btn {
    position: fixed;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    cursor: pointer;
    z-index: ${Z_OVERLAY};
    padding: 6px 12px;
    border-radius: 9999px;
    isolation: isolate;
    contain: layout paint;
    font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: rgba(28, 28, 30, 0.82);
    background: light-dark(rgba(245, 245, 245, 0.85), rgba(28, 28, 30, 0.82));
    color: light-dark(#111, #f5f5f5);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.20),
      0 1px 3px rgba(0, 0, 0, 0.14),
      0 4px 12px rgba(0, 0, 0, 0.18);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    animation: gf-popover-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .gf-rephrase-btn:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .gf-rephrase-btn:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-rephrase-btn {
      background: light-dark(
        color-mix(in oklab, #f5f5f5 55%, transparent),
        color-mix(in oklab, #1c1c1e 42%, transparent)
      );
      border-color: color-mix(in oklab, white 14%, transparent);
      -webkit-backdrop-filter: blur(12px) saturate(170%);
      backdrop-filter: blur(12px) saturate(170%);
    }
  }

  .gf-rephrase-card {
    position: fixed;
    pointer-events: auto;
    z-index: ${Z_OVERLAY};
    /* When promoted to the top layer via popover=manual + showPopover(), the
       UA stylesheet applies inset:0 + margin:auto, which CENTERS the card and
       overrides our explicit left/top (the card opened over the selection /
       button, not the viewport). Reset both so our JS positionCard() left/top
       wins — same fix as .gf-panel above. */
    margin: 0;
    inset: auto;
    min-width: 280px;
    max-width: 380px;
    padding: 12px 14px;
    border-radius: 14px;
    isolation: isolate;
    contain: layout paint;
    background: rgba(28, 28, 30, 0.78);
    background: light-dark(rgba(245, 245, 245, 0.85), rgba(28, 28, 30, 0.78));
    color: light-dark(#111, #f5f5f5);
    border: 1px solid rgba(255, 255, 255, 0.10);
    box-shadow:
      inset 0 1px 0 0 rgba(255, 255, 255, 0.18),
      0 1px 2px rgba(0, 0, 0, 0.12),
      0 8px 24px rgba(0, 0, 0, 0.20);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    transform-origin: 50% 100%;
    animation: gf-popover-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    .gf-rephrase-card {
      background: light-dark(
        color-mix(in oklab, #f5f5f5 50%, transparent),
        color-mix(in oklab, #1c1c1e 40%, transparent)
      );
      border-color: color-mix(in oklab, white 14%, transparent);
      -webkit-backdrop-filter: blur(16px) saturate(180%);
      backdrop-filter: blur(16px) saturate(180%);
    }
  }

  .gf-rephrase-card__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .gf-rephrase-card__label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.85;
  }
  .gf-rephrase-card__close {
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: inherit;
    font: 600 16px/1 system-ui, sans-serif;
    cursor: pointer;
    opacity: 0.7;
    transition: background 120ms ease-out, opacity 120ms ease-out;
  }
  .gf-rephrase-card__close:hover {
    background: rgba(255, 255, 255, 0.10);
    opacity: 1;
  }
  .gf-rephrase-card__close:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  .gf-rephrase-card__original {
    font-size: 12px;
    line-height: 1.4;
    opacity: 0.55;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.10);
  }
  .gf-rephrase-card__text {
    font-size: 14px;
    line-height: 1.45;
    margin-bottom: 12px;
    word-break: break-word;
  }
  .gf-rephrase-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .gf-rephrase-card__btn {
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
  .gf-rephrase-card__btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.30);
  }
  .gf-rephrase-card__btn:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }
  .gf-rephrase-card__btn--primary {
    background: #2563eb;
    border-color: #1d4ed8;
    color: #fff;
  }
  .gf-rephrase-card__btn--primary:hover {
    background: #1d4ed8;
    border-color: #1e40af;
  }

  /* Pending card (LLM round-trip in flight). Inline spinner + status text,
     no action buttons. Replaces the old empty-action toast hack. */
  .gf-rephrase-card__pending-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
  }
  .gf-rephrase-card__spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.25);
    border-top-color: rgba(255, 255, 255, 0.9);
    animation: gf-spin 0.8s linear infinite;
  }
  @keyframes gf-spin { to { transform: rotate(360deg); } }

  /* ============================================================
   * Liquid-glass refractive RIM — an additive highlight ring (does not touch
   * the base box-shadow). Bright specular top edge + a hairline all around so
   * the panel edge reads as a glass lens. The backdrop displacement filter
   * (gf-glass-distortion, wired into backdrop-filter above) supplies the
   * refraction; this is the bright rim that sells it.
   * ============================================================ */
  .gf-panel::after,
  .gf-pill-panel::after,
  .gf-tooltip::after,
  .gf-rephrase-card::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    /* Bright specular top edge + a faint refractive ring all around — a clean
       static glass rim. (An SVG displacement filter on this ring turned the
       border into jagged noise, so the lensing is conveyed by the rim alone.) */
    box-shadow:
      inset 0 1px 1.5px rgba(255, 255, 255, 0.5),
      inset 1px 0 1px rgba(255, 255, 255, 0.18),
      inset -1px 0 1px rgba(255, 255, 255, 0.18),
      inset 0 0 0 1px rgba(255, 255, 255, 0.12),
      inset 0 -1px 1px rgba(0, 0, 0, 0.18);
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
    color: light-dark(#b91c1c, #fca5a5);
    text-decoration: line-through;
    text-decoration-color: #ef4444;
  }
  .gf-diff__arrow {
    opacity: 0.7;
    margin: 0 2px;
  }
  .gf-diff__new {
    color: #4ade80;
    font-weight: 700;
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
   * Undo toast — transient bottom-center pill, e.g. "Ignored · Undo".
   * Auto-dismisses (default 1.2s); the action button cancels the timer
   * and fires onAction. Lives in the same shadow root as the rest of
   * the overlay so overlay.destroy() removes it.
   * ============================================================ */
  .gf-toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%);
    z-index: ${Z_OVERLAY};
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-radius: 9999px;
    pointer-events: auto;
    background: light-dark(rgba(245, 245, 245, 0.92), rgba(28, 28, 30, 0.92));
    color: light-dark(#111, #f5f5f5);
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
    animation: gf-pill-enter ${DURATION_TOOLTIP_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  .gf-toast__action {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #60a5fa;
    font: inherit;
    font-weight: 600;
    padding: 0;
  }
  .gf-toast__action:focus-visible {
    outline: 2px solid #93c5fd;
    outline-offset: 1px;
  }

  /* ============================================================
   * Reduced-transparency: drop the glass, bump scrim to ~92% opaque
   * ============================================================ */
  @media (prefers-reduced-transparency: reduce) {
    .gf-panel,
    .gf-pill,
    .gf-pill-panel,
    .gf-tooltip,
    .gf-toast,
    .gf-rephrase-btn,
    .gf-rephrase-card {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
      background: color-mix(in oklab, #1c1c1e 92%, transparent);
      background: light-dark(
        color-mix(in oklab, #f5f5f5 92%, transparent),
        color-mix(in oklab, #1c1c1e 92%, transparent)
      );
      border-color: color-mix(in oklab, white 8%, transparent);
    }
  }

  /* ============================================================
   * High-contrast: no glass blur so the rim stays crisp. Highlight CSS
   * has its own prefers-contrast override above (thicker outline + more
   * opaque tint).
   * ============================================================ */
  @media (prefers-contrast: more) {
    .gf-panel, .gf-pill, .gf-tooltip, .gf-pill-panel, .gf-toast, .gf-rephrase-card {
      backdrop-filter: none; -webkit-backdrop-filter: none;
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
    .gf-panel {
      animation-duration: 1ms;
      animation-name: gf-no-motion;
    }
    /* The pill's enter is transform-only; drop it entirely under reduced
       motion (don't swap to gf-no-motion — that animates opacity and would
       force the faint idle pill fully opaque). */
    .gf-pill { animation: none; }
    .gf-tooltip,
    .gf-toast {
      animation-duration: 1ms;
      animation-name: gf-no-motion;
    }
    .gf-u { transition: none; }
    .gf-u--applied { animation: none; }
    /* Spinner spin is gratuitous motion — kill it. */
    .gf-rephrase-card__spinner { animation: none; }
  }
  @keyframes gf-no-motion {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* ============================================================
   * SHARED DESIGN SYSTEM (ported from
   * .opencode/specs/2026-06-15-client-redesign/handoff/scss/).
   * The [data-gf-theme="light|dark"] attribute on the host picks
   * the palette; Vencord always renders data-gf-theme="dark", the
   * browser extension should set it from page/OS theme. No-attribute
   * default is the existing light-dark() behaviour in the rules
   * above (the new tokens/classes below only apply when the
   * attribute is set).
   *
   * ENTRANCE ANIMATION RULE: surface entrance keyframes
   * (gf-pop, gf-panel-in, gf-celebrate) animate TRANSFORM ONLY —
   * never opacity. Surfaces default to opacity:1 so a reduced-
   * motion or non-animating context never strands a popover
   * invisible. Toasts, scan lines, and pips may animate opacity
   * (they are not surface popovers).
   * ============================================================ */

  /* ----- Design tokens: light theme ----- */
  :host([data-gf-theme="light"]) {
    --gf-accent: #2563eb;
    --gf-accent-hover: #1d4ed8;
    --gf-accent-soft: rgba(37, 99, 235, 0.18);
    --gf-cat-spelling: #ef4444;
    --gf-cat-grammar: #eab308;
    --gf-cat-punctuation: #06b6d4;
    --gf-cat-style: #8b5cf6;
    --gf-cat-typography: #6b7280;
    --gf-band-excellent: #16a34a;
    --gf-band-good: #0891b2;
    --gf-band-fair: #d97706;
    --gf-band-needswork: #dc2626;
    --gf-conf-high: #16a34a;
    --gf-conf-medium: #d97706;
    --gf-conf-low: #64748b;
    --gf-diff-old: #b91c1c;
    --gf-diff-new: #15803d;
    --gf-ai-violet: #8b5cf6;
    --gf-ai-text: #7c3aed;
    --gf-success: #22c55e;
    --gf-ui: #0f172a;
    --gf-muted: #64748b;
    --gf-faint: #94a3b8;
    --gf-ink: #21242b;
    --gf-r-pill: 9999px;
    --gf-r-panel: 16px;
    --gf-r-card: 14px;
    --gf-r-chip: 8px;
    --gf-sp-1: 4px;
    --gf-sp-2: 6px;
    --gf-sp-3: 8px;
    --gf-sp-4: 11px;
    --gf-sp-5: 14px;
    --gf-dur-fast: 120ms;
    --gf-dur-pop: 180ms;
    --gf-dur-panel: 240ms;
    --gf-ease: cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* ----- Design tokens: dark theme ----- */
  :host([data-gf-theme="dark"]) {
    --gf-accent: #2563eb;
    --gf-accent-hover: #1d4ed8;
    --gf-accent-soft: rgba(37, 99, 235, 0.18);
    --gf-cat-spelling: #ef4444;
    --gf-cat-grammar: #eab308;
    --gf-cat-punctuation: #06b6d4;
    --gf-cat-style: #8b5cf6;
    --gf-cat-typography: #6b7280;
    --gf-band-excellent: #16a34a;
    --gf-band-good: #0891b2;
    --gf-band-fair: #d97706;
    --gf-band-needswork: #dc2626;
    --gf-conf-high: #16a34a;
    --gf-conf-medium: #d97706;
    --gf-conf-low: #6d7079;
    --gf-diff-old: #fca5a5;
    --gf-diff-new: #86efac;
    --gf-ai-violet: #8b5cf6;
    --gf-ai-text: #c4b5fd;
    --gf-success: #22c55e;
    --gf-ui: #f1f3f6;
    --gf-muted: #b5bac1;
    --gf-faint: #6d7079;
    --gf-ink: #dfe2e8;
    --gf-r-pill: 9999px;
    --gf-r-panel: 16px;
    --gf-r-card: 14px;
    --gf-r-chip: 8px;
    --gf-sp-1: 4px;
    --gf-sp-2: 6px;
    --gf-sp-3: 8px;
    --gf-sp-4: 11px;
    --gf-sp-5: 14px;
    --gf-dur-fast: 120ms;
    --gf-dur-pop: 180ms;
    --gf-dur-panel: 240ms;
    --gf-ease: cubic-bezier(0.22, 1, 0.36, 1);
  }

  /* ----- Glass surface (light + dark variants) -----
   * Apply to any floating GF surface by adding both .gf-surface
   * and the per-host data-gf-theme attribute. Position/inset/width
   * are component-specific (set on .gf-card / .gf-panel / .gf-orb
   * etc); the glass material here is the shared recipe. */
  :host([data-gf-theme="light"]) .gf-surface {
    position: relative;
    isolation: isolate;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.95) 0%, rgba(255, 255, 255, 0.80) 100%);
    border: 1px solid rgba(255, 255, 255, 0.70);
    backdrop-filter: blur(34px) saturate(195%) brightness(1.04);
    -webkit-backdrop-filter: blur(34px) saturate(195%) brightness(1.04);
    box-shadow: 0 2px 10px rgba(15, 23, 42, 0.08), 0 18px 50px rgba(15, 23, 42, 0.16);
    color: var(--gf-ui);
    border-radius: var(--gf-r-card);
  }
  :host([data-gf-theme="light"]) .gf-surface::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
      inset 0 2px 1.5px rgba(255, 255, 255, 0.95),
      inset 1px 0 1px rgba(255, 255, 255, 0.50),
      inset -1px 0 1px rgba(255, 255, 255, 0.50),
      inset 0 0 0 1px rgba(255, 255, 255, 0.50),
      inset 0 -1.5px 1.5px rgba(15, 23, 42, 0.06);
  }
  :host([data-gf-theme="dark"]) .gf-surface {
    position: relative;
    isolation: isolate;
    background: linear-gradient(180deg, rgba(54, 58, 68, 0.84) 0%, rgba(33, 36, 43, 0.80) 100%);
    border: 1px solid rgba(255, 255, 255, 0.10);
    backdrop-filter: blur(34px) saturate(200%) brightness(1.05);
    -webkit-backdrop-filter: blur(34px) saturate(200%) brightness(1.05);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.46), 0 22px 56px rgba(0, 0, 0, 0.56);
    color: var(--gf-ink);
    border-radius: var(--gf-r-card);
  }
  :host([data-gf-theme="dark"]) .gf-surface::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow:
      inset 0 2px 2px rgba(255, 255, 255, 0.22),
      inset 1px 0 1px rgba(255, 255, 255, 0.10),
      inset -1px 0 1px rgba(255, 255, 255, 0.10),
      inset 0 0 0 1px rgba(255, 255, 255, 0.11),
      inset 0 -2px 2px rgba(0, 0, 0, 0.42);
  }

  /* ----- Issue underline (in-composer marker) -----
   * Underline ALWAYS shows. Background tint appears ONLY on
   * hover or when the issue's card is open (.is-on). */
  .gf-u {
    text-decoration: underline wavy;
    text-decoration-thickness: 1.7px;
    text-underline-offset: 3px;
    border-radius: 2px;
    transition: background 120ms ease-out;
    text-decoration-skip-ink: none;
  }
  .gf-u--spelling    { text-decoration-color: var(--gf-cat-spelling); }
  .gf-u--spelling.is-on    { background: color-mix(in srgb, var(--gf-cat-spelling) 22%, transparent); }
  .gf-u--grammar     { text-decoration-color: var(--gf-cat-grammar); }
  .gf-u--grammar.is-on     { background: color-mix(in srgb, var(--gf-cat-grammar) 22%, transparent); }
  .gf-u--punctuation { text-decoration-color: var(--gf-cat-punctuation); }
  .gf-u--punctuation.is-on { background: color-mix(in srgb, var(--gf-cat-punctuation) 22%, transparent); }
  .gf-u--style       { text-decoration-color: var(--gf-cat-style); }
  .gf-u--style.is-on       { background: color-mix(in srgb, var(--gf-cat-style) 22%, transparent); }
  .gf-u--typography  { text-decoration-color: var(--gf-cat-typography); }
  .gf-u--typography.is-on  { background: color-mix(in srgb, var(--gf-cat-typography) 22%, transparent); }

  /* ----- Hover preview pill (diff only) ----- */
  .gf-tip {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: var(--gf-sp-2);
    white-space: nowrap;
    padding: 5px 11px;
    border-radius: var(--gf-r-pill);
    font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    pointer-events: none;
    z-index: 30;
  }
  .gf-tip__dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .gf-tip__old { text-decoration: line-through; }
  .gf-tip__new { font-weight: 700; }
  .gf-tip__tail {
    position: absolute;
    top: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
  }
  :host([data-gf-theme="dark"]) .gf-tip {
    backdrop-filter: blur(16px) saturate(180%);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    background: rgba(28, 30, 36, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--gf-ink);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.50);
  }
  :host([data-gf-theme="dark"]) .gf-tip__old { color: var(--gf-diff-old); }
  :host([data-gf-theme="dark"]) .gf-tip__new { color: var(--gf-diff-new); }
  :host([data-gf-theme="dark"]) .gf-tip__tail { border-top: 5px solid rgba(28, 30, 36, 0.94); }
  :host([data-gf-theme="light"]) .gf-tip {
    backdrop-filter: blur(16px) saturate(180%);
    -webkit-backdrop-filter: blur(16px) saturate(180%);
    background: rgba(252, 252, 254, 0.96);
    border: 1px solid rgba(15, 23, 42, 0.10);
    color: #1f2937;
    box-shadow: 0 6px 22px rgba(15, 23, 42, 0.18);
  }
  :host([data-gf-theme="light"]) .gf-tip__old { color: var(--gf-diff-old); }
  :host([data-gf-theme="light"]) .gf-tip__new { color: var(--gf-diff-new); }
  :host([data-gf-theme="light"]) .gf-tip__tail { border-top: 5px solid rgba(252, 252, 254, 0.96); }

  /* ----- Correction card (the popover when wrapped in .gf-surface
   *       + data-gf-theme on the host). The existing .gf-panel rules
   *       above are the live correction popover; .gf-card is the
   *       design-system canonical correction card for future use. */
  .gf-card {
    position: absolute;
    width: 320px;
    padding: var(--gf-sp-5);
    z-index: 40;
    animation: gf-pop var(--gf-dur-pop) var(--gf-ease);
  }
  .gf-card__head { display: flex; align-items: center; gap: var(--gf-sp-3); margin-bottom: 9px; }
  .gf-card__cat  { font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.05em; }
  .gf-card__msg  { font: 400 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin-bottom: var(--gf-sp-4); }
  .gf-card__conf { display: flex; align-items: center; gap: var(--gf-sp-3); margin-bottom: var(--gf-sp-5); }
  .gf-card__confbar { flex: 1; max-width: 120px; height: 5px; border-radius: 3px; overflow: hidden;
                      background: rgba(127, 127, 140, 0.16); }
  .gf-card__actions { display: flex; gap: var(--gf-sp-2); }
  .gf-card__alts { display: flex; flex-wrap: wrap; gap: var(--gf-sp-2); margin-top: var(--gf-sp-4); }
  .gf-card__dict { width: 100%; margin-top: var(--gf-sp-4); }
  .gf-card__nav  { display: flex; align-items: center; gap: var(--gf-sp-3); margin-top: var(--gf-sp-4);
                   padding-top: var(--gf-sp-3); border-top: 1px solid rgba(127, 127, 140, 0.18); }
  .gf-card__tail { position: absolute; top: 100%; transform: translateX(-50%);
                   width: 0; height: 0; border-left: 7px solid transparent; border-right: 7px solid transparent; }

  /* ----- Source chip (model provenance) ----- */
  .gf-chip-source {
    display: inline-flex;
    align-items: center;
    gap: var(--gf-sp-1);
    height: 20px;
    padding: 0 var(--gf-sp-3);
    border-radius: var(--gf-r-pill);
    font: 600 10.5px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.02em;
    background: rgba(127, 127, 140, 0.10);
    border: 1px solid rgba(127, 127, 140, 0.18);
  }
  .gf-chip-source--ai {
    background: linear-gradient(135deg, rgba(139, 92, 246, 0.22), rgba(37, 99, 235, 0.22));
    border-color: rgba(139, 92, 246, 0.40);
    color: var(--gf-ai-text);
  }
  .gf-chip-source__hint { opacity: 0.6; font-weight: 500; }

  /* ----- Buttons ----- */
  .gf-btn-primary {
    height: 34px;
    border: none;
    border-radius: 9px;
    cursor: pointer;
    background: var(--gf-accent);
    color: #fff;
    font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    transition: background 120ms ease-out, transform 120ms ease-out, box-shadow 150ms ease-out;
  }
  .gf-btn-primary:hover { background: var(--gf-accent-hover); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(37, 99, 235, 0.42); }
  .gf-btn-primary:active { transform: translateY(0); }
  .gf-btn-soft {
    height: 34px;
    border: 1px solid rgba(127, 127, 140, 0.22);
    border-radius: 9px;
    cursor: pointer;
    background: transparent;
    font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    transition: background 120ms ease-out, transform 120ms ease-out;
  }
  .gf-btn-soft:hover { background: rgba(127, 127, 140, 0.14); transform: translateY(-1px); }

  /* ----- Status pill / orb (entry point) ----- */
  .gf-orb {
    border-radius: 50%;
    cursor: pointer;
    transition: transform 200ms var(--gf-ease);
  }
  .gf-orb:hover  { transform: scale(1.06); }
  .gf-orb:active { transform: scale(0.97); }

  /* ----- Grouped correction row in the assistant panel list ----- */
  .gf-row {
    display: flex;
    align-items: center;
    gap: var(--gf-sp-3);
    width: 100%;
    text-align: left;
    padding: 8px 9px;
    border: none;
    border-radius: 9px;
    cursor: pointer;
    background: rgba(127, 127, 140, 0.06);
    transition: background 120ms ease-out, transform 120ms ease-out;
  }
  .gf-row:hover { background: rgba(127, 127, 140, 0.14); transform: translateX(3px); }

  /* ----- Rephrase / goals / synonyms popovers (new design).
   *       Existing .gf-rephrase-btn / .gf-rephrase-card above are the
   *       live in-page rephrase flow; the .gf-rephrase / .gf-goals /
   *       .gf-syn classes here are the design-system canonical
   *       popovers. */
  .gf-rephrase { width: 360px; padding: 15px; border-radius: var(--gf-r-panel); z-index: 50; }
  .gf-goals    { width: 300px; padding: 15px; border-radius: var(--gf-r-panel); z-index: 55; }
  .gf-syn      { width: 190px; padding: 8px;  border-radius: 13px; z-index: 42; }

  /* ----- Skeleton shimmer (LLM generating rephrase) ----- */
  .gf-skel {
    border-radius: 11px;
    background: linear-gradient(90deg, rgba(127, 127, 140, 0.10) 25%, rgba(37, 99, 235, 0.18) 50%, rgba(127, 127, 140, 0.10) 75%);
    background-size: 200% 100%;
    animation: gf-shimmer 1.5s linear infinite;
  }

  /* ----- Segmented control (tabs / rephrase scope / goals / tone) ----- */
  .gf-seg {
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: transparent;
    transition: background 150ms ease-out, color 150ms ease-out, box-shadow 150ms ease-out;
  }
  .gf-seg.is-active { background: rgba(127, 127, 140, 0.18); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18); }

  /* ----- Streaming scan line (fast-pass visual) ----- */
  .gf-scanline {
    position: absolute;
    left: 0;
    right: 0;
    height: 64px;
    pointer-events: none;
    z-index: 8;
    background: linear-gradient(180deg, rgba(37, 99, 235, 0) 0%, rgba(37, 99, 235, 0.12) 50%, rgba(37, 99, 235, 0) 100%);
    border-top: 1px solid rgba(37, 99, 235, 0.40);
    animation: gf-scan 1100ms ease-in-out;
  }

  /* ----- Score ring (SVG arc; color = band, offset = 1 - score/100) ----- */
  .gf-ring__arc { transition: stroke-dashoffset 600ms var(--gf-ease), stroke 400ms ease-out; }

  /* ============================================================
   * ENTRANCE KEYFRAMES (transform-only discipline).
   * gf-pop, gf-panel-in, gf-celebrate animate transform ONLY so a
   * reduced-motion / non-animating context never strands a surface
   * at opacity:0. gf-toast-in / gf-scan / gf-pip / gf-shimmer are
   * visual effects (not surface entrances) and may animate opacity.
   * ============================================================ */
  @keyframes gf-pop {
    from { transform: scale(0.985) translateY(2px); }
    to   { transform: none; }
  }
  @keyframes gf-panel-in {
    from { transform: scale(0.965) translateY(8px); }
    to   { transform: none; }
  }
  @keyframes gf-toast-in {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }
  @keyframes gf-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @keyframes gf-scan {
    0%        { top: -2%; opacity: 0; }
    12%, 88%  { opacity: 1; }
    100%      { top: 102%; opacity: 0; }
  }
  @keyframes gf-pip {
    0%, 100% { transform: scale(1);    opacity: 1; }
    50%      { transform: scale(1.16); opacity: 0.78; }
  }
  @keyframes gf-celebrate {
    0%   { transform: scale(1); }
    35%  { transform: scale(1.16); }
    70%  { transform: scale(0.96); }
    100% { transform: scale(1); }
  }
`
