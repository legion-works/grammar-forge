import { describe, expect, test } from "vitest";
import { collectPartRanges, overlapsAnyRange } from "./part-filter";
import type { PromptPart } from "./opencode-types";

const part = (start: number, end: number, type = "text"): PromptPart => ({
    type,
    source: { text: { start, end, value: "" } },
});

describe("collectPartRanges", () => {
    test("extracts ranges, skips parts without source", () => {
        const parts: PromptPart[] = [part(2, 6), { type: "agent" }, part(10, 14, "file")];
        expect(collectPartRanges(parts)).toEqual([
            { start: 2, end: 6 },
            { start: 10, end: 14 },
        ]);
    });
    test("extracts text (source.text), agent (source.{start,end}), and file (source.text) shapes", () => {
        const parts: PromptPart[] = [
            {
                type: "text",
                source: { text: { start: 2, end: 6, value: "hello" } },
            },
            {
                type: "agent",
                source: { start: 10, end: 14, value: "@code-reviewer" },
            },
            {
                type: "file",
                source: { text: { start: 18, end: 26, value: "src/main.ts" } },
            },
        ];
        expect(collectPartRanges(parts)).toEqual([
            { start: 2, end: 6 },
            { start: 10, end: 14 },
            { start: 18, end: 26 },
        ]);
    });
    test("prefers source.text when both shapes are present on a part", () => {
        const parts: PromptPart[] = [
            {
                type: "weird",
                source: {
                    start: 1,
                    end: 2,
                    text: { start: 5, end: 10, value: "" },
                },
            },
        ];
        expect(collectPartRanges(parts)).toEqual([{ start: 5, end: 10 }]);
    });
});

describe("overlapsAnyRange", () => {
    const ranges = [
        { start: 2, end: 6 },
        { start: 10, end: 14 },
    ];
    test("clear of all ranges", () => {
        expect(overlapsAnyRange({ start: 6, end: 10 }, ranges)).toBe(false);
    });
    test("partial overlap left edge", () => {
        expect(overlapsAnyRange({ start: 0, end: 3 }, ranges)).toBe(true);
    });
    test("contained", () => {
        expect(overlapsAnyRange({ start: 11, end: 12 }, ranges)).toBe(true);
    });
    test("touching end is NOT overlap (half-open spans)", () => {
        expect(overlapsAnyRange({ start: 14, end: 16 }, ranges)).toBe(false);
    });
});
