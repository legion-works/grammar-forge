// Pure positioning helper for the at-word floating overlay card.
// No opentui dependency — fully testable under vitest.
//
// The overlay card is positioned ABOVE the anchor word by default.
// If there is not enough space above, it flips BELOW. Left edge is
// clamped so the card never overflows the right edge of the terminal.
//
// All coordinates are in terminal cells (columns / rows).

export interface AnchorPoint {
    x: number;
    y: number;
}

export interface ClampedPosition {
    left: number;
    top: number;
}

/**
 * Compute the clamped top-left position for a floating overlay card.
 *
 * @param anchor   Absolute screen position of the word's start cell.
 * @param cardW    Card width in columns (including border).
 * @param cardH    Card height in rows (including border).
 * @param screenW  Terminal width in columns.
 * @param screenH  Terminal height in rows.
 * @returns        {left, top} — absolute screen position for the card's
 *                 top-left corner.
 *
 * Positioning rules:
 *   - Prefer ABOVE the word: top = anchor.y - cardH
 *   - If top < 0 (no room above), flip BELOW: top = anchor.y + 1
 *   - left = anchor.x, clamped to [0, screenW - cardW]
 */
export function clampAnchor(
    anchor: AnchorPoint,
    cardW: number,
    cardH: number,
    screenW: number,
    screenH: number,
): ClampedPosition {
    // Horizontal: clamp so the card doesn't overflow the right edge.
    const maxLeft = Math.max(0, screenW - cardW);
    const left = Math.min(Math.max(0, anchor.x), maxLeft);

    // Vertical: prefer above, flip below if no room.
    const topAbove = anchor.y - cardH;
    const top = topAbove >= 0 ? topAbove : Math.min(anchor.y + 1, Math.max(0, screenH - cardH));

    return { left, top };
}

/**
 * Compute the position for INLINE ghost completion text.
 *
 * Unlike {@link clampAnchor} (built for the floating CARD, which prefers
 * rendering ABOVE the anchor so the card body has room), inline ghost text is a
 * visual continuation of the typed line — it MUST sit on the caret's EXACT row.
 * Reusing clampAnchor put the ghost one row above the caret (`top = y - cardH`,
 * cardH=1), which is glaringly visible when the prompt is pinned to the terminal
 * bottom (session view): the continuation appeared on the blank line above the
 * text, indented to the caret column.
 *
 * Rules:
 *   - top = anchor.y EXACTLY (clamped to the screen), never flipped.
 *   - left = anchor.x (the caret column), clamped so at least one column stays
 *     on screen. The caller sizes the ghost box width to the remaining columns.
 *
 * @param anchor  Absolute screen position of the caret cell.
 * @param screenW Terminal width in columns.
 * @param screenH Terminal height in rows.
 */
export function ghostAnchor(
    anchor: AnchorPoint,
    screenW: number,
    screenH: number,
): ClampedPosition {
    const left = Math.min(Math.max(0, anchor.x), Math.max(0, screenW - 1));
    const top = Math.min(Math.max(0, anchor.y), Math.max(0, screenH - 1));
    return { left, top };
}

/** Smallest sane card width (border + padding + at least a couple columns of
 *  content). Below this the card stops being useful, but we still clamp here
 *  rather than going negative/zero on a pathologically narrow terminal. */
const MIN_CARD_W = 10;

/**
 * P1-5: derive the card's width (in columns, including border) from the
 * terminal's actual width instead of always using the fixed 44-column
 * default. `clampAnchor` above only clamps the card's LEFT position so it
 * doesn't overflow the right edge — it never shrinks the card itself, so on
 * a terminal narrower than `maxWidth` (e.g. an 80-col default minus a split
 * pane, or a genuinely small window) the card still renders at its full
 * fixed width and overflows.
 *
 * @param screenW   Terminal width in columns (from useTerminalDimensions()).
 * @param maxWidth  The card's preferred/maximum width. Defaults to 44 (the
 *                  fixed CARD_W tui-entry.tsx used before this fix).
 * @param margin    Columns to leave clear on at least one side so the card
 *                  never touches the terminal edge. Defaults to 2.
 */
export function computeCardWidth(
    screenW: number,
    maxWidth: number = 44,
    margin: number = 2,
): number {
    return Math.max(MIN_CARD_W, Math.min(maxWidth, screenW - margin));
}
