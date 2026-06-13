import { describe, expect, test } from "vitest";
import {
    codeUnitToDisplayOffset,
    displaySpanFromCodeUnits,
    displaySpansForItems,
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

describe("buildDisplayOffsetLookup / displaySpansForItems — parity with per-span path", () => {
    // PROPERTY TEST: displaySpansForItems must return EXACTLY the same result
    // as mapping displaySpanFromCodeUnits over each span individually.
    // This guarantees byte-identical behavior for the cached batch path.

    const texts = [
        // ASCII
        "hello world",
        // CJK
        "你好世界",
        // emoji ZWJ cluster
        "👨‍👩‍👧‍👦 hi",
        // combining marks (e + combining acute = é)
        "cafe\u0301 test",
        // embedded newline
        "line one\nline two",
        // empty
        "",
        // mixed
        "abc汉def😀ghi",
    ];

    const spanSets: Array<Array<{ start: number; end: number }>> = [
        // ASCII spans
        [
            { start: 0, end: 5 },
            { start: 6, end: 11 },
            { start: 3, end: 3 }, // zero-width
            { start: -1, end: 0 }, // out-of-range start
            { start: 0, end: 999 }, // past-end
        ],
        // CJK spans (each char is 3 bytes in UTF-8 but 1 code unit)
        [
            { start: 0, end: 2 },
            { start: 1, end: 3 },
            { start: 0, end: 4 },
        ],
        // emoji ZWJ spans (mid-grapheme)
        [
            { start: 0, end: 1 }, // mid-grapheme end
            { start: 0, end: 11 }, // full ZWJ cluster (👨‍👩‍👧‍👦 = 11 code units)
            { start: 12, end: 14 }, // " h"
        ],
        // combining marks
        [
            { start: 0, end: 4 }, // "cafe" (e not yet combined)
            { start: 0, end: 5 }, // "cafe\u0301" = "café" as one grapheme cluster
            { start: 5, end: 10 },
        ],
        // newline spans
        [
            { start: 0, end: 8 }, // "line one"
            { start: 8, end: 9 }, // "\n"
            { start: 9, end: 17 }, // "line two"
        ],
        // empty text — all spans should return {start:0, end:0}
        [
            { start: 0, end: 0 },
            { start: 0, end: 5 },
        ],
        // mixed
        [
            { start: 0, end: 3 }, // "abc"
            { start: 3, end: 4 }, // "汉"
            { start: 4, end: 7 }, // "def"
            { start: 7, end: 9 }, // "😀" (surrogate pair = 2 code units)
            { start: 8, end: 9 }, // mid-emoji end
            { start: 7, end: 8 }, // mid-emoji start
        ],
    ];

    for (let ti = 0; ti < texts.length; ti++) {
        const text = texts[ti]!;
        const spans = spanSets[ti]!;
        test(`parity: text[${ti}] "${text.slice(0, 20).replace(/\n/g, "\\n")}"`, () => {
            const expected = spans.map((span) => displaySpanFromCodeUnits(text, span, width));
            const actual = displaySpansForItems(text, spans, width);
            expect(actual).toEqual(expected);
        });
    }

    test("returns empty array for empty spans input", () => {
        expect(displaySpansForItems("hello", [], width)).toEqual([]);
    });

    test("single span matches displaySpanFromCodeUnits exactly", () => {
        const text = "汉a汉";
        const span = { start: 1, end: 2 };
        expect(displaySpansForItems(text, [span], width)).toEqual([
            displaySpanFromCodeUnits(text, span, width),
        ]);
    });

    test("out-of-order spans are each converted independently (no sort assumption)", () => {
        const text = "hello world";
        const spans = [
            { start: 6, end: 11 },
            { start: 0, end: 5 },
        ];
        const expected = spans.map((s) => displaySpanFromCodeUnits(text, s, width));
        expect(displaySpansForItems(text, spans, width)).toEqual(expected);
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
