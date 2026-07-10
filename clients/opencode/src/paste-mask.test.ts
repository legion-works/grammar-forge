import { describe, expect, test } from "vitest";
import { maskPastePlaceholders } from "./paste-mask";
import type { PromptPart } from "./opencode-types";

// Helper: build a text part with source.text where slice(start,end) === value
// (i.e. offsets ARE code-unit into the given text string).
const textPartCodeUnit = (start: number, end: number, value: string): PromptPart => ({
    type: "text",
    source: { text: { start, end, value } },
});

// Helper: build a text part with source.text where offsets do NOT match
// (i.e. offsets are NOT code-unit into ref.text — triggers indexOf fallback).
const textPartBadOffsets = (start: number, end: number, value: string): PromptPart => ({
    type: "text",
    source: { text: { start, end, value } },
});

describe("maskPastePlaceholders", () => {
    // ── offset-based (slice === value) ──────────────────────────────────────

    test("masks a single placeholder when slice===value (code-unit offsets)", () => {
        // text: "Hello [Pasted ~5 lines] world"
        //        01234567890123456789012345678
        const placeholder = "[Pasted ~5 lines]";
        const text = `Hello ${placeholder} world`;
        const start = 6;
        const end = start + placeholder.length; // 6 + 17 = 23
        expect(text.slice(start, end)).toBe(placeholder); // self-verify fixture

        const parts: PromptPart[] = [textPartCodeUnit(start, end, placeholder)];
        const result = maskPastePlaceholders(text, parts);

        // Same length
        expect(result.length).toBe(text.length);
        // Placeholder region is all spaces
        expect(result.slice(start, end)).toBe(" ".repeat(placeholder.length));
        // Surrounding text is intact
        expect(result.slice(0, start)).toBe("Hello ");
        expect(result.slice(end)).toBe(" world");
    });

    test("masks multiple placeholders (all code-unit offsets)", () => {
        const p1 = "[Pasted ~3 lines]";
        const p2 = "[Pasted ~10 lines]";
        const text = `Start ${p1} middle ${p2} end`;
        const s1 = 6;
        const e1 = s1 + p1.length;
        const mid = " middle ";
        const s2 = e1 + mid.length;
        const e2 = s2 + p2.length;
        expect(text.slice(s1, e1)).toBe(p1);
        expect(text.slice(s2, e2)).toBe(p2);

        const parts: PromptPart[] = [textPartCodeUnit(s1, e1, p1), textPartCodeUnit(s2, e2, p2)];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        expect(result.slice(s1, e1)).toBe(" ".repeat(p1.length));
        expect(result.slice(s2, e2)).toBe(" ".repeat(p2.length));
        expect(result.slice(0, s1)).toBe("Start ");
        expect(result.slice(e1, s2)).toBe(mid);
        expect(result.slice(e2)).toBe(" end");
    });

    // ── indexOf fallback (slice !== value) ──────────────────────────────────

    test("falls back to indexOf when start/end don't slice to value", () => {
        const placeholder = "[Pasted ~5 lines]";
        const text = `Hello ${placeholder} world`;
        // Deliberately wrong offsets — do NOT match the actual position.
        const badStart = 0;
        const badEnd = 3;
        expect(text.slice(badStart, badEnd)).not.toBe(placeholder); // confirm mismatch

        const parts: PromptPart[] = [textPartBadOffsets(badStart, badEnd, placeholder)];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        // The placeholder should still be masked via indexOf
        const actualStart = text.indexOf(placeholder);
        expect(result.slice(actualStart, actualStart + placeholder.length)).toBe(
            " ".repeat(placeholder.length),
        );
        // Text before the placeholder is intact
        expect(result.slice(0, actualStart)).toBe("Hello ");
    });

    test("indexOf fallback masks ALL occurrences when value appears multiple times", () => {
        const placeholder = "[Pasted ~2 lines]";
        const text = `${placeholder} and ${placeholder}`;
        // Bad offsets that don't match either occurrence
        const parts: PromptPart[] = [textPartBadOffsets(99, 120, placeholder)];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        // Both occurrences should be masked
        const first = text.indexOf(placeholder);
        const second = text.indexOf(placeholder, first + placeholder.length);
        expect(result.slice(first, first + placeholder.length)).toBe(
            " ".repeat(placeholder.length),
        );
        expect(result.slice(second, second + placeholder.length)).toBe(
            " ".repeat(placeholder.length),
        );
    });

    // ── non-text parts are untouched ────────────────────────────────────────

    test("file parts (type=file) are not masked", () => {
        const text = "Hello world";
        const parts: PromptPart[] = [
            {
                type: "file",
                source: { text: { start: 0, end: 5, value: "Hello" } },
            },
        ];
        const result = maskPastePlaceholders(text, parts);
        expect(result).toBe(text);
    });

    test("agent parts (type=agent, no source.text) are not masked", () => {
        const text = "Hello @code-reviewer world";
        const parts: PromptPart[] = [
            {
                type: "agent",
                source: { start: 6, end: 20, value: "@code-reviewer" },
            },
        ];
        const result = maskPastePlaceholders(text, parts);
        expect(result).toBe(text);
    });

    test("plain text parts without source.text are not masked", () => {
        const text = "Hello world";
        const parts: PromptPart[] = [
            { type: "text" }, // no source at all
            { type: "text", source: {} }, // source but no .text
        ];
        const result = maskPastePlaceholders(text, parts);
        expect(result).toBe(text);
    });

    // ── edge cases ──────────────────────────────────────────────────────────

    test("empty parts array → text unchanged", () => {
        const text = "Hello world";
        expect(maskPastePlaceholders(text, [])).toBe(text);
    });

    test("empty text → empty string returned", () => {
        const parts: PromptPart[] = [textPartCodeUnit(0, 5, "Hello")];
        expect(maskPastePlaceholders("", parts)).toBe("");
    });

    test("part with empty value → text unchanged, no throw", () => {
        const text = "Hello world";
        const parts: PromptPart[] = [
            { type: "text", source: { text: { start: 0, end: 5, value: "" } } },
        ];
        expect(() => maskPastePlaceholders(text, parts)).not.toThrow();
        expect(maskPastePlaceholders(text, parts)).toBe(text);
    });

    test("value not found in text (indexOf fallback) → text unchanged, no throw", () => {
        const text = "Hello world";
        // Bad offsets AND value not in text
        const parts: PromptPart[] = [textPartBadOffsets(99, 120, "[Pasted ~99 lines]")];
        expect(() => maskPastePlaceholders(text, parts)).not.toThrow();
        expect(maskPastePlaceholders(text, parts)).toBe(text);
    });

    // ── length invariant ────────────────────────────────────────────────────

    test("length invariant: output.length === input.length in all cases", () => {
        const placeholder = "[Pasted ~5 lines]";
        const text = `Type here ${placeholder} more text`;

        const cases: Array<[string, PromptPart[]]> = [
            // code-unit path
            [
                text,
                [
                    textPartCodeUnit(
                        text.indexOf(placeholder),
                        text.indexOf(placeholder) + placeholder.length,
                        placeholder,
                    ),
                ],
            ],
            // indexOf fallback path
            [text, [textPartBadOffsets(0, 1, placeholder)]],
            // no match
            [text, [textPartBadOffsets(0, 1, "[Pasted ~999 lines]")]],
            // empty parts
            [text, []],
            // empty value
            ["hello", [{ type: "text", source: { text: { start: 0, end: 5, value: "" } } }]],
        ];

        for (const [input, parts] of cases) {
            const result = maskPastePlaceholders(input, parts);
            expect(result.length).toBe(input.length);
        }
    });

    // ── P0-2 regression: astral chars (surrogate pairs) before/around a
    // placeholder must not shift the mask window. Array.from(text) iterates
    // by CODE POINT (combining a surrogate pair into one element) while
    // start/end are UTF-16 CODE-UNIT offsets — the two disagree by one
    // index per astral char preceding the placeholder. ────────────────────

    test("P0-2: emoji (astral, 2 code units) BEFORE the placeholder does not shift the mask window", () => {
        const placeholder = "[Pasted ~5 lines]";
        const emoji = "\u{1F600}"; // 😀 — one code point, TWO UTF-16 code units
        const text = `Hi ${emoji} ${placeholder} world`;
        const start = text.indexOf(placeholder);
        const end = start + placeholder.length;
        expect(text.slice(start, end)).toBe(placeholder); // self-verify fixture

        const parts: PromptPart[] = [textPartCodeUnit(start, end, placeholder)];
        const result = maskPastePlaceholders(text, parts);

        // Length invariant — this is exactly the guard orchestrator.ts relies
        // on to decide "mask succeeded, safe to send"; a broken mask that
        // produces a SHORTER string here would (pre-fix) fall back to sending
        // the ORIGINAL unmasked text to the bridge.
        expect(result.length).toBe(text.length);
        // The placeholder window is fully masked — not shifted left/right.
        expect(result.slice(start, end)).toBe(" ".repeat(placeholder.length));
        expect(result.slice(0, start)).toBe(`Hi ${emoji} `);
        expect(result.slice(end)).toBe(" world");
    });

    test("P0-2: emoji inside the surrounding (non-masked) text is preserved intact", () => {
        const placeholder = "[Pasted ~3 lines]";
        const emoji = "\u{1F600}\u{1F601}"; // two astral chars, 4 UTF-16 units
        const text = `${emoji} start ${placeholder} end ${emoji}`;
        const start = text.indexOf(placeholder);
        const end = start + placeholder.length;
        expect(text.slice(start, end)).toBe(placeholder);

        const parts: PromptPart[] = [textPartCodeUnit(start, end, placeholder)];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        expect(result.slice(start, end)).toBe(" ".repeat(placeholder.length));
        // Surrounding text — including BOTH emoji runs — survives byte-for-byte.
        expect(result.slice(0, start)).toBe(`${emoji} start `);
        expect(result.slice(end)).toBe(` end ${emoji}`);
    });

    test("P0-2: multiple placeholders with surrogate pairs between them stay aligned", () => {
        const p1 = "[Pasted ~2 lines]";
        const p2 = "[Pasted ~4 lines]";
        const emoji = "\u{1F60E}"; // 😎
        const text = `${p1}${emoji}middle${emoji}${p2}`;
        const s1 = text.indexOf(p1);
        const e1 = s1 + p1.length;
        const s2 = text.indexOf(p2);
        const e2 = s2 + p2.length;
        expect(text.slice(s1, e1)).toBe(p1);
        expect(text.slice(s2, e2)).toBe(p2);

        const parts: PromptPart[] = [textPartCodeUnit(s1, e1, p1), textPartCodeUnit(s2, e2, p2)];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        expect(result.slice(s1, e1)).toBe(" ".repeat(p1.length));
        expect(result.slice(s2, e2)).toBe(" ".repeat(p2.length));
        // The emoji-flanked "middle" section between the two placeholders is untouched.
        expect(result.slice(e1, s2)).toBe(`${emoji}middle${emoji}`);
    });

    test("mixed: text part with placeholder + file part + agent part", () => {
        const placeholder = "[Pasted ~7 lines]";
        const text = `@agent ${placeholder} end`;
        const pStart = text.indexOf(placeholder);
        const pEnd = pStart + placeholder.length;
        expect(text.slice(pStart, pEnd)).toBe(placeholder);

        const parts: PromptPart[] = [
            { type: "agent", source: { start: 0, end: 6, value: "@agent" } },
            textPartCodeUnit(pStart, pEnd, placeholder),
            { type: "file", source: { text: { start: pEnd + 1, end: pEnd + 4, value: "end" } } },
        ];
        const result = maskPastePlaceholders(text, parts);

        expect(result.length).toBe(text.length);
        // Only the text part's placeholder is masked
        expect(result.slice(pStart, pEnd)).toBe(" ".repeat(placeholder.length));
        // Agent and file regions are untouched
        expect(result.slice(0, pStart)).toBe(`@agent `);
        expect(result.slice(pEnd)).toBe(" end");
    });
});
