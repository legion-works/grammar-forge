import { describe, expect, test } from "vitest";
import {
    codeUnitToDisplayOffset,
    displaySpanFromCodeUnits,
    makeDisplayWidth,
} from "./display-width";

// Deterministic stub mirroring Bun.stringWidth semantics for the cases we
// exercise: ASCII = 1, CJK = 2, emoji (incl. ZWJ clusters) = 2.
const stubSegmentWidth = (segment: string): number => {
    const cp = segment.codePointAt(0)!;
    if (cp >= 0x4e00 && cp <= 0x9fff) return 2; // CJK
    if (cp >= 0x1f000) return 2; // emoji plane
    return 1;
};
const width = makeDisplayWidth(stubSegmentWidth);

describe("makeDisplayWidth", () => {
    test("newline counts as one even when widthOf returns 0", () => {
        const zeroForNewline = (s: string): number => (s === "\n" ? 0 : 1);
        expect(makeDisplayWidth(zeroForNewline)("a\nb")).toBe(3);
    });
});

describe("codeUnitToDisplayOffset", () => {
    test("ascii: identity", () => {
        expect(codeUnitToDisplayOffset("hello", 3, width)).toBe(3);
    });
    test("newlines count as one column", () => {
        expect(codeUnitToDisplayOffset("ab\ncd", 4, width)).toBe(4);
    });
    test("wide CJK doubles", () => {
        expect(codeUnitToDisplayOffset("汉a", 1, width)).toBe(2);
        expect(codeUnitToDisplayOffset("汉a", 2, width)).toBe(3);
    });
    test("surrogate-pair emoji: 2 code units, width 2", () => {
        expect(codeUnitToDisplayOffset("😀x", 2, width)).toBe(2);
        expect(codeUnitToDisplayOffset("😀x", 3, width)).toBe(3);
    });
    test("ZWJ family emoji is ONE grapheme", () => {
        const family = "👨‍👩‍👧"; // one grapheme, width 2 per stub
        expect(codeUnitToDisplayOffset(family + "x", family.length, width)).toBe(2);
    });
    test("offset inside a grapheme clamps to the grapheme start", () => {
        expect(codeUnitToDisplayOffset("😀x", 1, width)).toBe(0);
    });
    test("end inside surrogate-pair clamps UP to grapheme end (width 2)", () => {
        expect(codeUnitToDisplayOffset("😀x", 1, width, "end")).toBe(2);
    });
    test("end inside ZWJ family cluster clamps UP to cluster end (width 2)", () => {
        const family = "👨‍👩‍👧";
        expect(codeUnitToDisplayOffset(family + "x", 2, width, "end")).toBe(2);
    });
    test("start-mode is the default", () => {
        expect(codeUnitToDisplayOffset("😀x", 1, width)).toBe(0);
    });
    test("offset past end clamps to total width", () => {
        expect(codeUnitToDisplayOffset("ab", 99, width)).toBe(2);
    });
    test("offset <= 0 returns 0", () => {
        expect(codeUnitToDisplayOffset("ab", 0, width)).toBe(0);
        expect(codeUnitToDisplayOffset("ab", -5, width)).toBe(0);
    });
});

describe("displaySpanFromCodeUnits", () => {
    test("maps both ends", () => {
        expect(displaySpanFromCodeUnits("汉a汉", { start: 1, end: 2 }, width)).toEqual({
            start: 2,
            end: 3,
        });
    });
    test("end-mode clamps UP at mid-grapheme so the target grapheme is included", () => {
        expect(displaySpanFromCodeUnits("😀x", { start: 0, end: 1 }, width)).toEqual({
            start: 0,
            end: 2,
        });
    });
});

describe("CRLF bug-compatibility", () => {
    // Intl.Segmenter treats "\r\n" as ONE grapheme. Production Bun.stringWidth("\r\n")
    // is 0, and OpenCode's promptOffsetWidth counts it 0 too (its `\n === segment`
    // check doesn't match "\r\n"). Mirror that behavior so a Windows-pasted newline
    // can't accidentally split a part range and become grammar-checkable.
    test('"a\\r\\nb" with stub("\\r\\n")=0 has total width 2', () => {
        const w = makeDisplayWidth((s) => (s === "\r\n" ? 0 : 1));
        expect(w("a\r\nb")).toBe(2);
    });
});
