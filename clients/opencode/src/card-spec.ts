// Pure card-spec builder. Given a DetailsViewModel, produce a
// plain-data CardSpec the JSX PanelComponent (tui-entry.tsx) walks
// via buildDetailsViewModel. NO opentui dependency — testable
// headlessly under vitest.
//
// This module is the FIX for a class of bug we've hit three times:
// the imperative render path read fields from a stale view-model
// shape and produced empty text runs. With the spec, every render
// field is enumerated up front; a unit test that asserts every
// segment.text is non-empty catches the dead-field regression
// headlessly.
//
// Color keys are symbolic ("category" / "delete" / "insert" / "dim")
// — the renderer resolves them to opentui hex strings via
// category-palette. We pre-resolve "category" here because the
// palette lookup is the same shared module the orchestrator uses
// for the underline foreground; the renderer doesn't need to know
// about categories.

import { CATEGORY_FG } from "./category-palette";
import type { DetailsViewModel } from "./details-panel";
import type { RephraseResultView } from "./details-panel-view";
import { wrapLines } from "./display-width";

export type SegmentColorKey = "category" | "delete" | "insert" | "dim";

export interface CardSegment {
    text: string;
    colorKey: SegmentColorKey;
    /** Resolved hex for "category"; for other keys the renderer
     *  looks up the fixed hex. We resolve up-front so the renderer
     *  is dumb and so the spec is fully self-describing for tests. */
    fg: string;
    bold?: boolean;
}

export interface CardRow {
    segments: CardSegment[];
}

export interface CardSpec {
    /** Outer box border color. Resolved from the item's category
     *  via category-palette — same source as the underline
     *  foreground. */
    borderColor: string;
    rows: CardRow[];
}

// Fixed terminal-friendly colors. These complement the CATEGORY_FG
// palette but are distinct (delete = RED for "the original will be
// removed", insert = GREEN for "the new text will appear"). The dim
// is the same neutral used for muted hints.
const DELETE_HEX = "#ef4444";
const INSERT_HEX = "#22c55e";
const DIM_HEX = "#6b7280";

/** Build a CardSpec from a DetailsViewModel. PURE — no I/O, no
 *  opentui. Every segment.text is a concrete string from the
 *  view-model; no `undefined` can leak through. */
export function buildCardSpec(vm: DetailsViewModel): CardSpec {
    const categoryHex = vm.categoryColorKey;
    // Pre-resolve the three diff segment colors. The rules:
    //   - normal:    left=delete (will be removed), right=insert
    //   - deletion:  left=delete, right=dim (the "∅" is muted)
    //   - insertion: left=dim (the "∅" is muted), right=insert
    const leftColor: SegmentColorKey = vm.diffMode === "insertion" ? "dim" : "delete";
    const rightColor: SegmentColorKey = vm.diffMode === "deletion" ? "dim" : "insert";
    const leftFg = leftColor === "dim" ? DIM_HEX : DELETE_HEX;
    const rightFg = rightColor === "dim" ? DIM_HEX : INSERT_HEX;
    return {
        borderColor: categoryHex,
        rows: [
            // Title: ✎ + label (category-colored, bold) + " " + index/total (dim)
            {
                segments: [
                    {
                        text: `✎ ${vm.categoryLabel}`,
                        colorKey: "category",
                        fg: categoryHex,
                        bold: true,
                    },
                    { text: ` ${vm.indexPlusOne}/${vm.total}`, colorKey: "dim", fg: DIM_HEX },
                ],
            },
            // Diff: left (delete or dim) | arrow (dim) | right (insert or dim)
            {
                segments: [
                    { text: vm.diffLeft, colorKey: leftColor, fg: leftFg },
                    { text: vm.diffArrow, colorKey: "dim", fg: DIM_HEX },
                    { text: vm.diffRight, colorKey: rightColor, fg: rightFg },
                ],
            },
            // Hints: single dim line.
            { segments: [{ text: vm.hints, colorKey: "dim", fg: DIM_HEX }] },
        ],
    };
}

// Re-export so tests can spot-check the palette key (intentionally
// subset of CATEGORY_FG keys).
export type CategoryColorKey = keyof typeof CATEGORY_FG;

// ─── Rephrase card builders ───────────────────────────────────────────────────
// Pure functions — no I/O, no opentui. Vitest-testable headlessly.

/** Braille spinner frames for the rephrase loading animation.
 *  The orchestrator pushes setView() on a timer to advance the frame;
 *  the component just reads the frame from the view (no in-component timer). */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Accent color for the rephrase card border (single source of truth). */
export const REPHRASE_ACCENT_HEX = "#8b5cf6"; // style-purple — distinct from category colors

/** Inner card width in display columns (CARD_W − 2 border − 2 pad). */
const INNER_WIDTH = 40;
/** Max visible content rows before scrolling (excluding header + hints). */
export const MAX_CONTENT_ROWS = 8;

/** Build a CardSpec for the rephrase-loading state.
 *  PURE — no I/O. The spinner glyph cycles by frame index. */
export function buildRephraseLoadingCardSpec(frame: number): CardSpec {
    const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋";
    return {
        borderColor: REPHRASE_ACCENT_HEX,
        rows: [
            {
                segments: [
                    {
                        text: "✎ Rephrase",
                        colorKey: "category",
                        fg: REPHRASE_ACCENT_HEX,
                        bold: true,
                    },
                    {
                        text: `  ${glyph} Rephrasing…`,
                        colorKey: "dim",
                        fg: DIM_HEX,
                    },
                ],
            },
        ],
    };
}

/** Build a CardSpec for the rephrase-result state.
 *  PURE — no I/O. Shows original → rephrased with accept/reject hints.
 *  When content exceeds MAX_CONTENT_ROWS, rows are windowed by scrollOffset;
 *  PgUp/PgDn hint is shown; a "↓ more" affordance appears on the last visible
 *  content row when more rows remain below. */
export function buildRephraseResultCardSpec(
    view: RephraseResultView,
    displayWidthOf: (s: string) => number,
): CardSpec & { contentRows: number } {
    const origLines = wrapLines(view.original, INNER_WIDTH, displayWidthOf);
    const replLines = wrapLines(view.rephrased, INNER_WIDTH, displayWidthOf);

    // Build the full content row list (title row is separate).
    const contentRows: CardRow[] = [];
    for (const line of origLines) {
        contentRows.push({ segments: [{ text: line, colorKey: "delete", fg: DIM_HEX }] });
    }
    // Arrow + first rephrased line
    contentRows.push({
        segments: [
            { text: " → ", colorKey: "dim", fg: DIM_HEX },
            { text: replLines[0] ?? "", colorKey: "insert", fg: INSERT_HEX },
        ],
    });
    for (let i = 1; i < replLines.length; i++) {
        contentRows.push({ segments: [{ text: replLines[i]!, colorKey: "insert", fg: INSERT_HEX }] });
    }

    const totalContent = contentRows.length;
    const maxScroll = Math.max(0, totalContent - MAX_CONTENT_ROWS);
    const so = Math.max(0, Math.min(view.scrollOffset, maxScroll));
    const visibleContent = contentRows.slice(so, so + MAX_CONTENT_ROWS);
    const hasMoreBelow = so + MAX_CONTENT_ROWS < totalContent;

    // Title row
    const rows: CardRow[] = [
        {
            segments: [{
                text: `✎ Rephrase${view.altTotal > 1 ? ` ‹ ${view.altIndex + 1}/${view.altTotal} ›` : ""}`,
                colorKey: "category",
                fg: REPHRASE_ACCENT_HEX,
                bold: true,
            }],
        },
    ];

    // Windowed content rows — append " ↓ more" to the last visible row when more below.
    for (let i = 0; i < visibleContent.length; i++) {
        const row = visibleContent[i]!;
        if (hasMoreBelow && i === visibleContent.length - 1) {
            const lastSeg = row.segments[row.segments.length - 1]!;
            row.segments = [
                ...row.segments.slice(0, -1),
                { ...lastSeg, text: lastSeg.text + " ↓ more" },
            ];
        }
        rows.push(row);
    }

    // Hints row: show scroll key hints when there IS overflow (even if not visible).
    const hasOverflow = totalContent > MAX_CONTENT_ROWS;
    const hintText = hasOverflow
        ? "⏎ apply · esc reject · ctrl+/ regenerate · PgUp/PgDn scroll"
        : "⏎ apply · esc reject · ctrl+/ regenerate";
    rows.push({ segments: [{ text: hintText, colorKey: "dim", fg: DIM_HEX }] });

    return {
        borderColor: REPHRASE_ACCENT_HEX,
        rows,
        contentRows: visibleContent.length,
    };
}
