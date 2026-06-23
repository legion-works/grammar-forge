import { describe, expect, test } from "vitest";
import { lineLooksUnfinished } from "./ghost-overlay";

describe("lineLooksUnfinished", () => {
    test("true for mid-sentence text", () => {
        expect(lineLooksUnfinished("The quick brown")).toBe(true);
        expect(lineLooksUnfinished('He said, "hello')).toBe(true);
        expect(lineLooksUnfinished("function foo(")).toBe(true);
        expect(lineLooksUnfinished("const x =")).toBe(true);
        expect(lineLooksUnfinished("abc")).toBe(true); // exactly 3 chars
    });
    test("false for terminal punctuation", () => {
        expect(lineLooksUnfinished("The quick brown fox.")).toBe(false);
        expect(lineLooksUnfinished("What time is it?")).toBe(false);
        expect(lineLooksUnfinished("Run!")).toBe(false);
        expect(lineLooksUnfinished("Options:")).toBe(false);
        expect(lineLooksUnfinished("Finish;")).toBe(false);
    });
    test("false for empty or whitespace-only", () => {
        expect(lineLooksUnfinished("")).toBe(false);
        expect(lineLooksUnfinished("   ")).toBe(false);
        expect(lineLooksUnfinished("\n\t")).toBe(false);
    });
    test("false for short text (<3 chars)", () => {
        expect(lineLooksUnfinished("ab")).toBe(false);
        expect(lineLooksUnfinished(" x")).toBe(false);
        expect(lineLooksUnfinished("a")).toBe(false);
    });
    test("non-terminal punctuation does not block", () => {
        expect(lineLooksUnfinished("hello,")).toBe(true);
        expect(lineLooksUnfinished('say "')).toBe(true);
        expect(lineLooksUnfinished("ax-")).toBe(true);
        expect(lineLooksUnfinished("foo)")).toBe(true);
    });
});
