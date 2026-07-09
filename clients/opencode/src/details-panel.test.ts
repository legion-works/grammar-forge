import { describe, expect, test } from "vitest";
import { buildDetailsViewModel, CATEGORY_LABEL } from "./details-panel";
import { CATEGORY_FG } from "./category-palette";

const item = (
    overrides: Partial<{
        category: string;
        original: string;
        replacement: string;
        isDeletion?: boolean;
    }> = {},
) => ({
    category: "spelling" as const,
    original: "teh",
    replacement: "the",
    ...overrides,
});

describe("CATEGORY_LABEL", () => {
    test("maps every known category", () => {
        expect(CATEGORY_LABEL.spelling).toBe("Spelling");
        expect(CATEGORY_LABEL.grammar).toBe("Grammar");
        expect(CATEGORY_LABEL.punctuation).toBe("Punctuation");
        expect(CATEGORY_LABEL.style).toBe("Style");
        expect(CATEGORY_LABEL.typography).toBe("Typography");
    });
    test("falls back to 'Issue' for unknown", () => {
        expect(CATEGORY_LABEL.unknown).toBe("Issue");
    });
});

describe("buildDetailsViewModel — bordered card shape", () => {
    test("title includes ✎ glyph + category label + 1-based index/total", () => {
        const vm = buildDetailsViewModel(item(), 0, 3);
        expect(vm.title).toBe("✎ Spelling 1/3");
    });
    test("title index uses 1-based counting", () => {
        const vm = buildDetailsViewModel(item(), 2, 5);
        expect(vm.title).toBe("✎ Spelling 3/5");
    });
    test("categoryColorKey returns the palette entry for the category", () => {
        const vm = buildDetailsViewModel(item({ category: "spelling" }), 0, 1);
        expect(vm.categoryColorKey).toBe(CATEGORY_FG.spelling);
        const vm2 = buildDetailsViewModel(item({ category: "grammar" }), 0, 1);
        expect(vm2.categoryColorKey).toBe(CATEGORY_FG.grammar);
    });
    test("categoryColorKey falls back to 'unknown' color for unmapped categories", () => {
        const vm = buildDetailsViewModel(item({ category: "made-up" }), 0, 1);
        expect(vm.categoryColorKey).toBe(CATEGORY_FG.unknown);
    });
    test("diff normal: left=original, right=replacement, arrow=' → '", () => {
        const vm = buildDetailsViewModel(item(), 0, 1);
        expect(vm.diffMode).toBe("normal");
        expect(vm.diffLeft).toBe("teh");
        expect(vm.diffRight).toBe("the");
        expect(vm.diffArrow).toBe(" → ");
    });
    test("diff deletion: left=original, right='∅'", () => {
        const vm = buildDetailsViewModel(item({ original: "abc", replacement: "" }), 0, 1);
        expect(vm.diffMode).toBe("deletion");
        expect(vm.diffLeft).toBe("abc");
        expect(vm.diffRight).toBe("∅");
    });
    test("diff insertion: left='∅', right=replacement", () => {
        const vm = buildDetailsViewModel(item({ original: "", replacement: "the" }), 0, 1);
        expect(vm.diffMode).toBe("insertion");
        expect(vm.diffLeft).toBe("∅");
        expect(vm.diffRight).toBe("the");
    });
    test("hints line lists all four bindings with ⏎ glyph (explicit keys)", () => {
        const vm = buildDetailsViewModel(item(), 0, 1, "/", ".");
        expect(vm.hints).toBe("⏎ apply · x ignore · / . cycle · esc close");
    });
    test("hints line defaults to '/ . cycle' when no keys are passed", () => {
        const vm = buildDetailsViewModel(item(), 0, 1);
        expect(vm.hints).toBe("⏎ apply · x ignore · / . cycle · esc close");
    });
    test("hints line derives from the actual bound cycle keys (no n/p drift)", () => {
        // Pass a custom set of cycle keys and confirm the hint matches.
        const vm = buildDetailsViewModel(item(), 0, 1, "]", "[");
        expect(vm.hints).toBe("⏎ apply · x ignore · ] [ cycle · esc close");
        // Must never contain the stale n/p shorthand.
        expect(vm.hints).not.toMatch(/n\/p/);
    });
    test("hints line never contains the legacy n/p cycle text", () => {
        const vmDefault = buildDetailsViewModel(item(), 0, 1);
        const vmExplicit = buildDetailsViewModel(item(), 0, 1, "/", ".");
        expect(vmDefault.hints).not.toMatch(/n\/p/);
        expect(vmExplicit.hints).not.toMatch(/n\/p/);
    });
    test("exposes the resolved cycleNextKey/cyclePrevKey so card-spec can build discrete hint segments", () => {
        const vm = buildDetailsViewModel(item(), 0, 1, "ctrl+n", "ctrl+p");
        expect(vm.cycleNextKey).toBe("ctrl+n");
        expect(vm.cyclePrevKey).toBe("ctrl+p");
        const vmDefault = buildDetailsViewModel(item(), 0, 1);
        expect(vmDefault.cycleNextKey).toBe("/");
        expect(vmDefault.cyclePrevKey).toBe(".");
    });

    test("category label uses the override category", () => {
        const vm = buildDetailsViewModel(item({ category: "grammar" }), 0, 1);
        expect(vm.categoryLabel).toBe("Grammar");
    });
    test("preserves the original word verbatim in the diff (whitespace included)", () => {
        const vm = buildDetailsViewModel(item({ original: "  has  ", replacement: "have" }), 0, 2);
        expect(vm.diffLeft).toBe("  has  ");
        expect(vm.diffRight).toBe("have");
    });
    test("fullText joins title + diff + hints with newlines", () => {
        const vm = buildDetailsViewModel(item(), 0, 1);
        expect(vm.fullText).toBe(
            "✎ Spelling 1/1\nteh → the\n⏎ apply · x ignore · / . cycle · esc close",
        );
    });

    test("diff normal: full-word 'has' → 'have' renders both full words", () => {
        const vm = buildDetailsViewModel(item({ original: "has", replacement: "have" }), 0, 1);
        expect(vm.diffMode).toBe("normal");
        expect(vm.diffLeft).toBe("has");
        expect(vm.diffRight).toBe("have");
    });

    test("diff deletion: isDeletion=true renders right='∅' even when replacement is non-empty", () => {
        const vm = buildDetailsViewModel(
            item({ original: "word", replacement: "word", isDeletion: true }),
            0,
            1,
        );
        expect(vm.diffMode).toBe("deletion");
        expect(vm.diffLeft).toBe("word");
        expect(vm.diffRight).toBe("∅");
    });

    test("diff insertion: isDeletion=false with empty original renders left='∅'", () => {
        const vm = buildDetailsViewModel(
            item({ original: "", replacement: "an", isDeletion: false }),
            0,
            1,
        );
        expect(vm.diffMode).toBe("insertion");
        expect(vm.diffLeft).toBe("∅");
        expect(vm.diffRight).toBe("an");
    });
});
