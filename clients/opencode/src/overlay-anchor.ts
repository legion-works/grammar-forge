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
