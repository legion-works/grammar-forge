import { describe, it, expect } from "vitest";
import { clampAnchor, ghostAnchor, computeCardWidth } from "./overlay-anchor";

// Terminal: 80 cols × 24 rows. Card: 44 wide × 5 tall.
const SCREEN_W = 80;
const SCREEN_H = 24;
const CARD_W = 44;
const CARD_H = 5;

describe("clampAnchor", () => {
    it("normal case: word in the middle, card fits above", () => {
        // anchor at col 10, row 15 — plenty of room above and to the right
        const pos = clampAnchor({ x: 10, y: 15 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.left).toBe(10);
        expect(pos.top).toBe(10); // 15 - 5 = 10
    });

    it("word near right edge: left is clamped so card stays on screen", () => {
        // anchor at col 70 — card would overflow: 70 + 44 = 114 > 80
        const pos = clampAnchor({ x: 70, y: 15 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.left).toBe(36); // 80 - 44 = 36
        expect(pos.top).toBe(10); // 15 - 5 = 10
    });

    it("word near top: card flips below when no room above", () => {
        // anchor at row 2 — card height 5, so topAbove = 2 - 5 = -3 < 0 → flip below
        const pos = clampAnchor({ x: 10, y: 2 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.left).toBe(10);
        expect(pos.top).toBe(3); // anchor.y + 1 = 3
    });

    it("word at row 0: card flips below", () => {
        const pos = clampAnchor({ x: 5, y: 0 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.left).toBe(5);
        expect(pos.top).toBe(1); // 0 + 1 = 1
    });

    it("word at exact boundary: topAbove = 0 is valid (fits above)", () => {
        // anchor.y = cardH → topAbove = 0 → fits above
        const pos = clampAnchor({ x: 10, y: CARD_H }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.top).toBe(0);
    });

    it("word at anchor.y = cardH - 1: topAbove = -1 → flip below", () => {
        const pos = clampAnchor({ x: 10, y: CARD_H - 1 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.top).toBe(CARD_H); // anchor.y + 1 = cardH
    });

    it("left is never negative even if anchor.x < 0", () => {
        const pos = clampAnchor({ x: -5, y: 10 }, CARD_W, CARD_H, SCREEN_W, SCREEN_H);
        expect(pos.left).toBe(0);
    });

    it("narrow terminal: left clamped to 0 when screenW < cardW", () => {
        const pos = clampAnchor({ x: 10, y: 10 }, CARD_W, CARD_H, 20, SCREEN_H);
        expect(pos.left).toBe(0); // max(0, 20 - 44) = 0
    });
});

describe("ghostAnchor", () => {
    it("sits on the caret's EXACT row — never flips above (unlike clampAnchor)", () => {
        // The bug: reusing clampAnchor put the ghost at y-1 (one row above the
        // caret), glaring when the prompt is pinned to the terminal bottom.
        const pos = ghostAnchor({ x: 18, y: 34 }, 120, 40);
        expect(pos.top).toBe(34); // EXACT caret row, not 33
        expect(pos.left).toBe(18); // EXACT caret column
    });

    it("prompt on the very bottom row stays on that row (no upward flip)", () => {
        const pos = ghostAnchor({ x: 5, y: 39 }, 120, 40);
        expect(pos.top).toBe(39);
        expect(pos.left).toBe(5);
    });

    it("clamps top into the screen when anchor.y is out of range", () => {
        const pos = ghostAnchor({ x: 5, y: 99 }, 120, 40);
        expect(pos.top).toBe(39); // screenH - 1
    });

    it("clamps left so at least one column stays on screen", () => {
        const pos = ghostAnchor({ x: 200, y: 10 }, 120, 40);
        expect(pos.left).toBe(119); // screenW - 1
    });

    it("clamps negatives to 0", () => {
        const pos = ghostAnchor({ x: -3, y: -2 }, 120, 40);
        expect(pos.left).toBe(0);
        expect(pos.top).toBe(0);
    });
});

describe("computeCardWidth (P1-5)", () => {
    it("wide terminal: returns the fixed max width (44)", () => {
        expect(computeCardWidth(120)).toBe(44);
        expect(computeCardWidth(80)).toBe(44);
    });

    it("narrow terminal: shrinks to screenW - margin", () => {
        // screenW=30, margin=2 (default) → 28, below maxWidth=44.
        expect(computeCardWidth(30)).toBe(28);
    });

    it("exact boundary: screenW - margin === maxWidth stays at maxWidth", () => {
        expect(computeCardWidth(46)).toBe(44); // 46 - 2 = 44
    });

    it("pathologically narrow but REAL terminal: floors at MIN_CARD_W (10)", () => {
        // 5 is a genuinely tiny but positive, finite screen width — a real
        // (if absurd) terminal size, not a "dimensions aren't ready" signal.
        expect(computeCardWidth(5)).toBe(10);
    });

    it("custom maxWidth/margin are honored", () => {
        expect(computeCardWidth(100, 60, 4)).toBe(60); // wide enough for the custom max
        expect(computeCardWidth(50, 60, 4)).toBe(46); // 50 - 4 = 46, below the custom max
    });

    it("the resulting width, combined with clampAnchor, never places the card past the right edge", () => {
        const screenW = 30;
        const cardW = computeCardWidth(screenW);
        const pos = clampAnchor({ x: 25, y: 10 }, cardW, 5, screenW, 24);
        expect(pos.left + cardW).toBeLessThanOrEqual(screenW);
    });

    // BUGFIX regression tests (live "new session: prompt much narrower"
    // report): `useTerminalDimensions()` is backed by the host's
    // CliRenderer.width, read at component-mount time — on a freshly-
    // mounted renderer (a new session's slot tree, before its first
    // native layout pass) this can read `0`, and if the accessor itself
    // were momentarily undefined on some host version, `screenW - margin`
    // would be `NaN`. Neither is a REAL terminal size (a live terminal is
    // never 0 columns wide), so both must fall back to `maxWidth` — the
    // fixed, known-good pre-P1-5 card width — instead of computing a
    // degenerate width.
    it("screenW === 0 (not-yet-sized renderer): falls back to maxWidth, NOT MIN_CARD_W", () => {
        expect(computeCardWidth(0)).toBe(44);
        expect(computeCardWidth(0, 60)).toBe(60);
    });

    it("screenW is NaN: falls back to maxWidth, never returns NaN", () => {
        expect(computeCardWidth(Number.NaN)).toBe(44);
        expect(Number.isNaN(computeCardWidth(Number.NaN))).toBe(false);
    });

    it("screenW is undefined (defensive — a caller passing through an unready accessor): falls back to maxWidth, never NaN", () => {
        expect(computeCardWidth(undefined as unknown as number)).toBe(44);
        expect(Number.isNaN(computeCardWidth(undefined as unknown as number))).toBe(false);
    });

    it("screenW is negative (never physically real): falls back to maxWidth rather than trusting bogus input", () => {
        expect(computeCardWidth(-100)).toBe(44);
    });

    it("degenerate screenW never produces a width clampAnchor can turn into NaN", () => {
        for (const screenW of [0, Number.NaN, -100, undefined as unknown as number]) {
            const cardW = computeCardWidth(screenW);
            expect(Number.isFinite(cardW)).toBe(true);
            const pos = clampAnchor({ x: 5, y: 10 }, cardW, 5, screenW, Number.NaN);
            expect(Number.isFinite(pos.left)).toBe(true);
            expect(Number.isFinite(pos.top)).toBe(true);
        }
    });
});
