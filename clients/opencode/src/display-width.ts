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
