import { describe, expect, test } from "vitest";
import { CATEGORY_FG, categoryColor } from "./category-palette";

describe("CATEGORY_FG / categoryColor", () => {
    test("every known category has a non-empty hex color", () => {
        for (const cat of [
            "spelling",
            "grammar",
            "punctuation",
            "style",
            "typography",
            "unknown",
        ]) {
            // CATEGORY_FG is now typed as Record<Category, string>; the test
            // iterates string literals, so we cast at the lookup (mirrors the
            // categoryColor() pattern).
            const v = (CATEGORY_FG as Record<string, string>)[cat];
            expect(typeof v).toBe("string");
            expect(v).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });

    test("categoryColor returns the mapped color for known categories", () => {
        expect(categoryColor("spelling")).toBe(CATEGORY_FG.spelling);
        expect(categoryColor("grammar")).toBe(CATEGORY_FG.grammar);
        expect(categoryColor("unknown")).toBe(CATEGORY_FG.unknown);
    });

    test("categoryColor falls back to 'unknown' color for unmapped categories", () => {
        expect(categoryColor("does-not-exist")).toBe(CATEGORY_FG.unknown);
        expect(categoryColor("")).toBe(CATEGORY_FG.unknown);
    });
});
