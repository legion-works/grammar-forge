import { describe, expect, test } from "vitest";
import {
    buildCardSpec,
    buildRephraseLoadingCardSpec,
    buildRephraseResultCardSpec,
    SPINNER_FRAMES,
    REPHRASE_ACCENT_HEX,
    MAX_CONTENT_ROWS,
    DELETE_HEX,
    INSERT_HEX,
    DIM_HEX,
} from "./card-spec";
import { buildDetailsViewModel } from "./details-panel";
import { CATEGORY_FG } from "./category-palette";

// Helper: build a real view-model (no mock view-model — we want
// the spec to be derived from the same builder the runtime uses).
const vm = (
    overrides: Partial<{ category: string; original: string; replacement: string }> = {},
    index = 0,
    total = 1,
) =>
    buildDetailsViewModel(
        { category: "spelling", original: "teh", replacement: "the", ...overrides },
        index,
        total,
    );

describe("buildCardSpec", () => {
    test("returns 3 rows (title / diff / hints) for a normal view-model", () => {
        const spec = buildCardSpec(vm());
        expect(spec.rows).toHaveLength(3);
    });

    test("REGRESSION GUARD: every segment.text is a non-empty string (no undefined leaks)", () => {
        // This is the EXACT regression guard for the dead-field bug:
        // pre-fix the imperative renderer read vm.headerLine /
        // messageLine / diffLine / hintsLine which were renamed to
        // title / (gone) / (gone) / hints. The spec MUST always
        // surface concrete strings.
        const cases = [
            vm(),
            vm({ original: "abc", replacement: "" }, 0, 1), // deletion
            vm({ original: "", replacement: "the" }, 0, 1), // insertion
            vm({ category: "grammar" }, 2, 5), // 3/5 indicator
            vm({ category: "punctuation", original: "  ", replacement: ", " }, 0, 1),
        ];
        for (const v of cases) {
            const spec = buildCardSpec(v);
            expect(spec.rows).toHaveLength(3);
            for (const row of spec.rows) {
                expect(row.segments.length).toBeGreaterThan(0);
                for (const seg of row.segments) {
                    expect(typeof seg.text).toBe("string");
                    expect(seg.text.length).toBeGreaterThan(0);
                    expect(seg.text).not.toBe("undefined");
                    expect(seg.text).not.toBe("null");
                }
            }
        }
    });

    test("border color = category color for the item's category", () => {
        const v = vm({ category: "spelling" });
        const spec = buildCardSpec(v);
        expect(spec.borderColor).toBe(CATEGORY_FG.spelling);
        const v2 = vm({ category: "grammar" });
        const spec2 = buildCardSpec(v2);
        expect(spec2.borderColor).toBe(CATEGORY_FG.grammar);
    });

    test("title row: segment 0 is bold + category-colored, segment 1 is dim", () => {
        const spec = buildCardSpec(vm({ category: "grammar" }, 1, 4));
        const titleRow = spec.rows[0]!;
        expect(titleRow.segments).toHaveLength(2);
        const [first, second] = titleRow.segments as [
            (typeof titleRow.segments)[0],
            (typeof titleRow.segments)[0],
        ];
        expect(first.bold).toBe(true);
        expect(first.colorKey).toBe("category");
        expect(first.fg).toBe(CATEGORY_FG.grammar);
        expect(first.text).toBe("✎ Grammar");
        expect(second.colorKey).toBe("dim");
        expect(second.text).toBe(" 2/4");
    });

    test("diff row: NORMAL mode — left=delete(red), arrow=dim, right=insert(green)", () => {
        const spec = buildCardSpec(vm({ original: "teh", replacement: "the" }));
        const diffRow = spec.rows[1]!;
        expect(diffRow.segments).toHaveLength(3);
        const [left, arrow, right] = diffRow.segments as [
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
        ];
        expect(left.text).toBe("teh");
        expect(left.colorKey).toBe("delete");
        expect(left.fg).toBe(DELETE_HEX);
        expect(arrow.text).toBe(" → ");
        expect(arrow.colorKey).toBe("dim");
        expect(right.text).toBe("the");
        expect(right.colorKey).toBe("insert");
        expect(right.fg).toBe(INSERT_HEX);
    });

    test("diff row: DELETION mode — left=delete(red), arrow=dim, right=dim", () => {
        const spec = buildCardSpec(vm({ original: "abc", replacement: "" }));
        const diffRow = spec.rows[1]!;
        const [left, _arrow, right] = diffRow.segments as [
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
        ];
        expect(left.text).toBe("abc");
        expect(left.colorKey).toBe("delete");
        expect(right.text).toBe("∅");
        expect(right.colorKey).toBe("dim"); // deletion: right is muted
    });

    test("diff row: INSERTION mode — left=dim, arrow=dim, right=insert(green)", () => {
        const spec = buildCardSpec(vm({ original: "", replacement: "the" }));
        const diffRow = spec.rows[1]!;
        const [left, _arrow, right] = diffRow.segments as [
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
            (typeof diffRow.segments)[0],
        ];
        expect(left.text).toBe("∅");
        expect(left.colorKey).toBe("dim"); // insertion: left is muted
        expect(right.text).toBe("the");
        expect(right.colorKey).toBe("insert");
    });

    test("hints row: discrete apply/ignore clickable segments + trailing cycle/close text (default keys)", () => {
        // §8 mouse checklist: "click apply / ignore words in the hint row
        // (NEW: render them as discrete clickable spans)". The row is split
        // into segments so the renderer can wire per-segment onMouseDown,
        // but the concatenation is byte-identical to the pre-split string.
        const spec = buildCardSpec(vm());
        const hintsRow = spec.rows[2]!;
        for (const seg of hintsRow.segments) {
            expect(seg.colorKey).toBe("dim");
        }
        const joined = hintsRow.segments.map((s) => s.text).join("");
        expect(joined).toBe("⏎ apply · x ignore · / . cycle · esc close");
        const applySeg = hintsRow.segments.find((s) => s.action === "apply");
        const ignoreSeg = hintsRow.segments.find((s) => s.action === "ignore");
        expect(applySeg?.text).toBe("⏎ apply");
        expect(ignoreSeg?.text).toBe("x ignore");
        // Everything else carries no action — a click there falls through
        // to the card's default (apply the pinned suggestion).
        const unactioned = hintsRow.segments.filter((s) => s.action === undefined);
        expect(unactioned.length).toBeGreaterThan(0);
    });

    test("hints row: apply/ignore segments reflect the actually bound cycle keys", () => {
        const item = { category: "spelling", original: "teh", replacement: "the" };
        const v = buildDetailsViewModel(item, 0, 1, "ctrl+n", "ctrl+p");
        const spec = buildCardSpec(v);
        const hintsRow = spec.rows[2]!;
        const joined = hintsRow.segments.map((s) => s.text).join("");
        expect(joined).toBe("⏎ apply · x ignore · ctrl+n ctrl+p cycle · esc close");
    });

    test("category color resolves correctly for every known category", () => {
        for (const cat of [
            "spelling",
            "grammar",
            "punctuation",
            "style",
            "typography",
            "unknown",
        ] as const) {
            const spec = buildCardSpec(vm({ category: cat }));
            expect(spec.borderColor).toBe(CATEGORY_FG[cat]);
        }
    });

    test("REGRESSION GUARD: diff/dim colors are the Legion Works OpenCode theme tokens, not the old defaults", () => {
        // Legion tokens (handoff/scss/_tokens.scss, dark/Tokyo Night):
        // --danger #ff757f, --success #c3e88d (Tokyo green), --text-muted #828bb8.
        // Guards against silently reverting to the pre-redesign ad-hoc reds/greens.
        expect(DELETE_HEX).toBe("#ff757f");
        expect(INSERT_HEX).toBe("#c3e88d");
        expect(DIM_HEX).toBe("#828bb8");
        // Distinct from the `style` category color (#8b5cf6) and from each other.
        expect(REPHRASE_ACCENT_HEX).not.toBe(CATEGORY_FG.style);
    });

    test("short diff (fits inner width): unchanged single-row shape, contentRows=1", () => {
        const spec = buildCardSpec(vm());
        expect(spec.rows).toHaveLength(3);
        expect(spec.contentRows).toBe(1);
    });

    test("WRAP (§5.5): a long replacement wraps the diff row instead of overflowing", () => {
        const longOriginal = "should of";
        const longReplacement =
            "should have already merged the fix before the release went out the door";
        const spec = buildCardSpec(
            vm({ original: longOriginal, replacement: longReplacement }),
            (s) => s.length,
        );
        // Grew past the 1-row fast path.
        expect(spec.contentRows).toBeGreaterThan(1);
        // Title + N diff rows + hints.
        expect(spec.rows).toHaveLength(2 + spec.contentRows);
        // Nothing truncated — the full replacement text appears somewhere,
        // reconstructed by joining every insert-colored segment.
        const insertText = spec.rows
            .flatMap((r) => r.segments)
            .filter((s) => s.colorKey === "insert")
            .map((s) => s.text)
            .join("");
        expect(insertText.replace(/\s+/g, " ")).toContain("already merged the fix");
        for (const row of spec.rows) {
            for (const seg of row.segments) {
                expect(seg.text).not.toContain("…");
            }
        }
    });

    test("WRAP: the arrow prefixes the first wrapped replacement line", () => {
        const spec = buildCardSpec(
            vm({
                original: "x",
                replacement: "a very long replacement string that will not fit on one line at all",
            }),
            (s) => s.length,
        );
        // Find the row containing the arrow.
        const arrowRow = spec.rows.find((r) => r.segments.some((s) => s.text === " → "));
        expect(arrowRow).toBeDefined();
        const arrowIdx = arrowRow!.segments.findIndex((s) => s.text === " → ");
        expect(arrowRow!.segments[arrowIdx + 1]!.colorKey).toBe("insert");
    });
});

describe("buildRephraseLoadingCardSpec", () => {
    test("returns a spec with the rephrase accent border color", () => {
        const spec = buildRephraseLoadingCardSpec(0);
        expect(spec.borderColor).toBe(REPHRASE_ACCENT_HEX);
    });

    test("has exactly 1 row with 2 segments (title + spinner+text)", () => {
        const spec = buildRephraseLoadingCardSpec(0);
        expect(spec.rows).toHaveLength(1);
        expect(spec.rows[0]!.segments).toHaveLength(2);
    });

    test("title segment is bold and accent-colored", () => {
        const spec = buildRephraseLoadingCardSpec(0);
        const title = spec.rows[0]!.segments[0]!;
        expect(title.text).toBe("✎ Rephrase");
        expect(title.bold).toBe(true);
        expect(title.fg).toBe(REPHRASE_ACCENT_HEX);
    });

    test("spinner segment contains the correct braille glyph for frame 0", () => {
        const spec = buildRephraseLoadingCardSpec(0);
        const spinner = spec.rows[0]!.segments[1]!;
        expect(spinner.text).toContain(SPINNER_FRAMES[0]);
        expect(spinner.text).toContain("Rephrasing");
    });

    test("spinner glyph cycles through all SPINNER_FRAMES by frame index", () => {
        for (let i = 0; i < SPINNER_FRAMES.length; i++) {
            const spec = buildRephraseLoadingCardSpec(i);
            const spinner = spec.rows[0]!.segments[1]!;
            expect(spinner.text).toContain(SPINNER_FRAMES[i]);
        }
    });

    test("spinner glyph wraps around (frame >= SPINNER_FRAMES.length)", () => {
        const spec0 = buildRephraseLoadingCardSpec(0);
        const specN = buildRephraseLoadingCardSpec(SPINNER_FRAMES.length);
        expect(spec0.rows[0]!.segments[1]!.text).toBe(specN.rows[0]!.segments[1]!.text);
    });

    test("REGRESSION GUARD: every segment.text is a non-empty string", () => {
        for (let frame = 0; frame < SPINNER_FRAMES.length * 2; frame++) {
            const spec = buildRephraseLoadingCardSpec(frame);
            for (const row of spec.rows) {
                for (const seg of row.segments) {
                    expect(typeof seg.text).toBe("string");
                    expect(seg.text.length).toBeGreaterThan(0);
                }
            }
        }
    });
});

describe("buildRephraseResultCardSpec", () => {
    const stubW = (s: string) => s.length;

    const makeView = (original: string, rephrased: string) => ({
        kind: "rephrase-result" as const,
        original,
        rephrased,
        alternatives: [] as string[],
        altIndex: 0,
        altTotal: 1,
        scrollOffset: 0,
        displayStart: 0,
    });

    test("returns a spec with the rephrase accent border color", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        expect(spec.borderColor).toBe(REPHRASE_ACCENT_HEX);
    });

    test("has at least 4 rows: title, original lines, arrow+rephrased, hints", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        expect(spec.rows.length).toBeGreaterThanOrEqual(4);
    });

    test("title row: bold accent-colored '✎ Rephrase'", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        const title = spec.rows[0]!.segments[0]!;
        expect(title.text).toBe("✎ Rephrase");
        expect(title.bold).toBe(true);
        expect(title.fg).toBe(REPHRASE_ACCENT_HEX);
    });

    test("original lines: contain the original text (possibly wrapped)", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello world", "hi there"), stubW);
        // Original text is in rows[1] (first original line)
        const origSeg = spec.rows[1]!.segments[0]!;
        expect(origSeg.text).toBe("hello world");
    });

    test("arrow+rephrased row: contains arrow and rephrased text", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        // Find the arrow row (the one with dim colorKey and contains "→")
        const arrowRow = spec.rows.find((r) =>
            r.segments.some((s) => s.text.includes("→")),
        );
        expect(arrowRow).toBeDefined();
        const texts = arrowRow!.segments.map((s) => s.text);
        expect(texts.join("")).toContain("→");
        expect(texts.join("")).toContain("hi there");
    });

    test("rephrased text segment has insert colorKey (green)", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        const allSegments = spec.rows.flatMap((r) => r.segments);
        const replSeg = allSegments.find((s) => s.text === "hi there");
        expect(replSeg).toBeDefined();
        expect(replSeg!.colorKey).toBe("insert");
    });

    test("hints row: contains accept and reject hints", () => {
        const spec = buildRephraseResultCardSpec(makeView("hello", "hi there"), stubW);
        const hintsRow = spec.rows[spec.rows.length - 1]!;
        const hints = hintsRow.segments[0]!;
        expect(hints.text).toContain("apply");
        expect(hints.text).toContain("reject");
        expect(hints.colorKey).toBe("dim");
    });

    test("long text wraps, not truncated (no ellipsis)", () => {
        const text = "In hindsight we should have merged the fix last week because the bug was already known and the patch was ready to ship";
        const spec = buildRephraseResultCardSpec(makeView(text, text), stubW);
        // No "…" truncation in any row
        for (const row of spec.rows) {
            for (const seg of row.segments) {
                expect(seg.text).not.toContain("…");
            }
        }
        expect(spec.contentRows).toBeGreaterThan(1);
    });

    test("REGRESSION GUARD: every segment.text is a non-empty string", () => {
        const cases = [
            makeView("hello", "hi there"),
            makeView("a".repeat(60), "b".repeat(60)),
            makeView("x", "y"),
        ];
        for (const view of cases) {
            const spec = buildRephraseResultCardSpec(view, stubW);
            for (const row of spec.rows) {
                for (const seg of row.segments) {
                    expect(typeof seg.text).toBe("string");
                    expect(seg.text.length).toBeGreaterThan(0);
                }
            }
        }
    });

    test("overflow WINDOWING: >MAX_CONTENT_ROWS text → capped visible rows + '↓ more' affordance", () => {
        // Create text that produces many wrapped lines (>8 = MAX_CONTENT_ROWS).
        // Use distinct numbered lines so we can verify scrolling changes the visible content.
        const longText = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ${"x".repeat(30)}`).join("\n");
        const view = makeView(longText, "short");

        // At scrollOffset=0, contentRows should be capped at MAX_CONTENT_ROWS (8).
        const spec0 = buildRephraseResultCardSpec({ ...view, scrollOffset: 0 }, stubW);
        expect(spec0.contentRows).toBeLessThanOrEqual(MAX_CONTENT_ROWS);
        expect(spec0.contentRows).toBe(8);

        // The hints row should show PgUp/PgDn when there IS overflow.
        const hintsRow0 = spec0.rows[spec0.rows.length - 1]!;
        const hints0 = hintsRow0.segments[0]!;
        expect(hints0.text).toContain("PgUp/PgDn");

        // The last visible content row should have " ↓ more" appended.
        // Content rows start at index 1 (title is index 0).
        const lastContentRow0 = spec0.rows[spec0.rows.length - 2]!; // before hints
        const lastSeg0 = lastContentRow0.segments[lastContentRow0.segments.length - 1]!;
        expect(lastSeg0.text).toContain("↓ more");

        // At scrollOffset=1, we should see different content.
        const spec1 = buildRephraseResultCardSpec({ ...view, scrollOffset: 1 }, stubW);
        expect(spec1.contentRows).toBe(8);

        // The first content row at offset 0 should show "Line 1:"
        const firstContentRow0 = spec0.rows[1]!;
        expect(firstContentRow0.segments[0]!.text).toContain("Line 1:");

        // The first content row at offset 1 should show "Line 2:" (scrolled past line 1)
        const firstContentRow1 = spec1.rows[1]!;
        expect(firstContentRow1.segments[0]!.text).toContain("Line 2:");

        // Scroll fully to the end: should still have rows (the last page).
        // At maxScroll, visibleContent = contentRows.slice(maxScroll, maxScroll+8),
        // which may still be 8 rows if totalContent >= maxScroll+8.
        const specEnd = buildRephraseResultCardSpec({ ...view, scrollOffset: 100 }, stubW);
        // contentRows is at most MAX_CONTENT_ROWS and at least 1.
        expect(specEnd.contentRows).toBeGreaterThan(0);
        expect(specEnd.contentRows).toBeLessThanOrEqual(MAX_CONTENT_ROWS);

        // Text with no overflow: <= MAX_CONTENT_ROWS content rows has no PgUp/PgDn hint.
        const shortView = makeView("hello", "hi");
        const specShort = buildRephraseResultCardSpec(shortView, stubW);
        const hintsRowShort = specShort.rows[specShort.rows.length - 1]!;
        expect(hintsRowShort.segments[0]!.text).not.toContain("PgUp/PgDn");
    });
});
