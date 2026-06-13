// Prompt parts (pastes, file attachments, agent mentions) are never
// grammar-checked — drop any suggestion overlapping a part range.
// Ranges are display-width extmark coords, half-open [start, end).
import type { PromptPart } from "./opencode-types";

export interface DisplaySpan {
    start: number;
    end: number;
}

export function collectPartRanges(parts: readonly PromptPart[]): DisplaySpan[] {
    const ranges: DisplaySpan[] = [];
    for (const part of parts) {
        const source = part.source;
        if (!source) continue;
        // Prefer source.text.{start,end} (TextPart-extended, FilePart);
        // fall back to source.{start,end} directly (AgentPart carries
        // its range on the outer source, no .text nesting).
        const range = source.text
            ? { start: source.text.start, end: source.text.end }
            : source.start !== undefined && source.end !== undefined
              ? { start: source.start, end: source.end }
              : undefined;
        if (range) ranges.push({ start: range.start, end: range.end });
    }
    return ranges;
}

export function overlapsAnyRange(span: DisplaySpan, ranges: readonly DisplaySpan[]): boolean {
    for (const range of ranges) {
        if (span.start < range.end && range.start < span.end) return true;
    }
    return false;
}
