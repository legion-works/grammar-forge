// UTF-16 code-unit offsets (what @/lib/pipeline emits) → display-width
// offsets (what OpenCode extmarks / PromptRef.replaceRange consume).
//
// Display-width semantics MUST mirror OpenCode's promptOffsetWidth
// (packages/tui/src/prompt/display.ts): per-grapheme via Intl.Segmenter,
// Bun.stringWidth per grapheme, newline counts as 1 (Bun.stringWidth gives
// it 0). Production injects Bun.stringWidth; tests inject a stub.
// ONE width abstraction repo-wide: displayWidthOf(value: string): number,
// newline-aware, valid for full strings AND single graphemes.

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type SegmentWidthFn = (segment: string) => number;

/** Production segment-width: Bun.stringWidth. The OpenCode runtime is Bun;
 *  there is no non-Bun production path. */
export function bunSegmentWidth(segment: string): number {
    const bun = (globalThis as { Bun?: { stringWidth(s: string): number } }).Bun;
    if (!bun) throw new Error("grammarforge-opencode requires the Bun runtime");
    return bun.stringWidth(segment);
}

/** Build the newline-aware total-width function from a per-segment width. */
export function makeDisplayWidth(widthOf: SegmentWidthFn) {
    return (value: string): number => {
        let total = 0;
        for (const part of graphemeSegmenter.segment(value)) {
            total += part.segment === "\n" ? 1 : widthOf(part.segment);
        }
        return total;
    };
}

/** Map a UTF-16 code-unit offset in `text` to a display-width offset.
 *  Offsets landing INSIDE a grapheme clamp to a grapheme boundary so a span
 *  can never split a grapheme: start-mode clamps DOWN to the grapheme's
 *  start, end-mode clamps UP to the grapheme's end (mirrors the core
 *  patch's snapping — a replacement span must INCLUDE its target grapheme).
 *  Out-of-range offsets clamp to 0 / total width. */
export function codeUnitToDisplayOffset(
    text: string,
    codeUnitOffset: number,
    displayWidthOf: (value: string) => number,
    mode: "start" | "end" = "start",
): number {
    if (codeUnitOffset <= 0) return 0;
    let consumedCodeUnits = 0;
    let displayOffset = 0;
    for (const part of graphemeSegmenter.segment(text)) {
        const next = consumedCodeUnits + part.segment.length;
        if (codeUnitOffset < next) {
            // mid-grapheme: clamp to grapheme start (start-mode) or end (end-mode)
            return displayOffset + (mode === "end" ? displayWidthOf(part.segment) : 0);
        }
        displayOffset += displayWidthOf(part.segment);
        consumedCodeUnits = next;
        if (codeUnitOffset === consumedCodeUnits) return displayOffset;
    }
    return displayOffset; // past end → total width
}

export interface CodeUnitSpan {
    start: number;
    end: number;
}

export function displaySpanFromCodeUnits(
    text: string,
    span: CodeUnitSpan,
    displayWidthOf: (value: string) => number,
): CodeUnitSpan {
    return {
        start: codeUnitToDisplayOffset(text, span.start, displayWidthOf, "start"),
        end: codeUnitToDisplayOffset(text, span.end, displayWidthOf, "end"),
    };
}

/** A lookup table built in ONE Segmenter pass over `text`.
 *  `offsetAt(codeUnit, mode)` is byte-identical to
 *  `codeUnitToDisplayOffset(text, codeUnit, displayWidthOf, mode)` but
 *  uses a binary search over pre-built checkpoints instead of re-scanning
 *  from the start each time. Complexity: O(text) to build, O(log text) per
 *  query. */
export interface DisplayOffsetLookup {
    offsetAt(codeUnit: number, mode: "start" | "end"): number;
}

export function buildDisplayOffsetLookup(
    text: string,
    displayWidthOf: (value: string) => number,
): DisplayOffsetLookup {
    // Each checkpoint records the cumulative code-unit position and the
    // cumulative display-width AFTER consuming that grapheme.
    // Index 0 is the implicit "before text" sentinel: {cu:0, display:0}.
    // Index k is the boundary AFTER the k-th grapheme.
    const cuBoundaries: number[] = [0];
    const displayBoundaries: number[] = [0];

    let consumedCodeUnits = 0;
    let displayOffset = 0;
    for (const part of graphemeSegmenter.segment(text)) {
        consumedCodeUnits += part.segment.length;
        displayOffset += part.segment === "\n" ? 1 : displayWidthOf(part.segment);
        cuBoundaries.push(consumedCodeUnits);
        displayBoundaries.push(displayOffset);
    }
    const totalDisplay = displayOffset;
    const totalCu = consumedCodeUnits;

    return {
        offsetAt(codeUnit: number, mode: "start" | "end"): number {
            // Mirror codeUnitToDisplayOffset semantics exactly:
            if (codeUnit <= 0) return 0;
            if (codeUnit >= totalCu) return totalDisplay;

            // Binary search for the grapheme boundary AFTER codeUnit.
            // cuBoundaries is sorted ascending. We want the smallest index i
            // such that cuBoundaries[i] >= codeUnit.
            let lo = 0;
            let hi = cuBoundaries.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (cuBoundaries[mid]! < codeUnit) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            // lo is now the index of the first boundary >= codeUnit.
            if (cuBoundaries[lo] === codeUnit) {
                // Exact boundary hit — same as the loop's `if (codeUnitOffset === consumedCodeUnits)` branch.
                return displayBoundaries[lo]!;
            }
            // codeUnit lands INSIDE the grapheme that ends at boundary lo.
            // The grapheme STARTS at boundary lo-1.
            // start-mode → clamp DOWN to grapheme start = displayBoundaries[lo-1]
            // end-mode   → clamp UP to grapheme end   = displayBoundaries[lo]
            if (mode === "end") {
                return displayBoundaries[lo]!;
            }
            return displayBoundaries[lo - 1]!;
        },
    };
}

/** Convert many code-unit spans to display spans in a single Segmenter pass.
 *  Byte-identical to mapping `displaySpanFromCodeUnits(text, span, displayWidthOf)`
 *  over each span, but O(text + spans·log text) instead of O(text·spans).
 *  Spans are processed in input order; no sorting is assumed or applied. */
export function displaySpansForItems(
    text: string,
    spans: ReadonlyArray<CodeUnitSpan>,
    displayWidthOf: (value: string) => number,
): CodeUnitSpan[] {
    if (spans.length === 0) return [];
    const lookup = buildDisplayOffsetLookup(text, displayWidthOf);
    return spans.map((span) => ({
        start: lookup.offsetAt(span.start, "start"),
        end: lookup.offsetAt(span.end, "end"),
    }));
}
