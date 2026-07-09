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

/** Mouse action a segment triggers on click (opencode-interaction.md §4/§8:
 *  "click apply/ignore words in the hint row → discrete clickable spans").
 *  Undefined for segments that aren't independently clickable — a click
 *  there falls through to the card's default (apply the pinned suggestion /
 *  accept the rephrase), same as clicking anywhere else on the card body. */
export type SegmentAction = "apply" | "ignore";

export interface CardSegment {
    text: string;
    colorKey: SegmentColorKey;
    /** Resolved hex for "category"; for other keys the renderer
     *  looks up the fixed hex. We resolve up-front so the renderer
     *  is dumb and so the spec is fully self-describing for tests. */
    fg: string;
    bold?: boolean;
    /** When set, the renderer wires this segment's onMouseDown to the
     *  matching controller callback (onApply / onIgnore) and stops
     *  propagation so it doesn't also fire the card's default apply. */
    action?: SegmentAction;
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

// Legion Works OpenCode theme colors (Tokyo Night dark, the DS default —
// see handoff/scss/_tokens.scss). These complement the CATEGORY_FG palette
// (unchanged editorial semantics) but are distinct: delete = the DS
// --danger red for "the original will be removed", insert = the DS
// --success (Tokyo green) for "the new text will appear". DIM is the DS
// --text-muted, the same neutral used for hints/status/ghost text
// everywhere in this plugin (single source of truth — see the re-exports
// below, consumed by tui-entry.tsx for the status line + ghost overlay).
export const DELETE_HEX = "#ff757f"; // --danger (dark)
export const INSERT_HEX = "#c3e88d"; // --success (dark, Tokyo green)
export const DIM_HEX = "#828bb8"; // --text-muted (dark)

/** Build a CardSpec from a DetailsViewModel. PURE — no I/O, no
 *  opentui. Every segment.text is a concrete string from the
 *  view-model; no `undefined` can leak through.
 *
 *  `displayWidthOf` defaults to `.length` (fine for the ASCII-heavy unit
 *  tests); production (tui-entry.tsx) passes the real grapheme/wide-char
 *  aware width fn so wrapping matches the terminal's actual columns.
 *  When the one-line diff fits the card's inner width it renders exactly
 *  as before (single 3-segment row) — wrapping only engages for long
 *  replacements (§5.5 of opencode-interaction.md: "the same wrap helper
 *  should back the suggestion card's diff row when a replacement is
 *  long"). `contentRows` reports how many diff rows were produced so the
 *  caller can grow the card height (mirrors buildRephraseResultCardSpec). */
export function buildCardSpec(
    vm: DetailsViewModel,
    displayWidthOf: (s: string) => number = (s) => s.length,
): CardSpec & { contentRows: number } {
    const categoryHex = vm.categoryColorKey;
    // Pre-resolve the three diff segment colors. The rules:
    //   - normal:    left=delete (will be removed), right=insert
    //   - deletion:  left=delete, right=dim (the "∅" is muted)
    //   - insertion: left=dim (the "∅" is muted), right=insert
    const leftColor: SegmentColorKey = vm.diffMode === "insertion" ? "dim" : "delete";
    const rightColor: SegmentColorKey = vm.diffMode === "deletion" ? "dim" : "insert";
    const leftFg = leftColor === "dim" ? DIM_HEX : DELETE_HEX;
    const rightFg = rightColor === "dim" ? DIM_HEX : INSERT_HEX;

    const titleRow: CardRow = {
        segments: [
            {
                text: `✎ ${vm.categoryLabel}`,
                colorKey: "category",
                fg: categoryHex,
                bold: true,
            },
            { text: ` ${vm.indexPlusOne}/${vm.total}`, colorKey: "dim", fg: DIM_HEX },
        ],
    };
    // Discrete clickable spans for "apply" / "ignore" (opencode-interaction.md
    // §4 mouse table + §8 checklist). The concatenation of these segments'
    // text is byte-identical to `vm.hints` (built from the same
    // cycleNextKey/cyclePrevKey) — splitting it here doesn't change what's
    // on screen, only which cells carry their own onMouseDown.
    const hintsRow: CardRow = {
        segments: [
            { text: "⏎ apply", colorKey: "dim", fg: DIM_HEX, action: "apply" },
            { text: " · ", colorKey: "dim", fg: DIM_HEX },
            { text: "x ignore", colorKey: "dim", fg: DIM_HEX, action: "ignore" },
            {
                text: ` · ${vm.cycleNextKey} ${vm.cyclePrevKey} cycle · esc close`,
                colorKey: "dim",
                fg: DIM_HEX,
            },
        ],
    };

    // One-line fast path: identical output to the pre-wrap implementation
    // when the diff fits — every existing short-suggestion test keeps
    // passing unchanged.
    const oneLine = `${vm.diffLeft}${vm.diffArrow}${vm.diffRight}`;
    let diffRows: CardRow[];
    if (displayWidthOf(oneLine) <= INNER_WIDTH) {
        diffRows = [
            {
                segments: [
                    { text: vm.diffLeft, colorKey: leftColor, fg: leftFg },
                    { text: vm.diffArrow, colorKey: "dim", fg: DIM_HEX },
                    { text: vm.diffRight, colorKey: rightColor, fg: rightFg },
                ],
            },
        ];
    } else {
        // Wrap, don't truncate: left (original) lines first, then the
        // arrow prefixed to the first replacement line, then any
        // continuation replacement lines.
        const leftLines = wrapLines(vm.diffLeft, INNER_WIDTH, displayWidthOf);
        const rightLines = wrapLines(vm.diffRight, INNER_WIDTH, displayWidthOf);
        diffRows = [];
        for (const line of leftLines) {
            diffRows.push({ segments: [{ text: line, colorKey: leftColor, fg: leftFg }] });
        }
        diffRows.push({
            segments: [
                { text: vm.diffArrow, colorKey: "dim", fg: DIM_HEX },
                { text: rightLines[0] ?? "", colorKey: rightColor, fg: rightFg },
            ],
        });
        for (let i = 1; i < rightLines.length; i++) {
            diffRows.push({ segments: [{ text: rightLines[i]!, colorKey: rightColor, fg: rightFg }] });
        }
    }

    return {
        borderColor: categoryHex,
        rows: [titleRow, ...diffRows, hintsRow],
        contentRows: diffRows.length,
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

/** Accent color for the rephrase card border (single source of truth).
 *  Legion's "Geth Purple" (--purple-400, dark) — the AI/rephrase accent.
 *  Deliberately distinct from the `style` category's `#8b5cf6` (unchanged
 *  editorial semantic in CATEGORY_FG) so a rephrase card is never visually
 *  confused with a style-category suggestion card. */
export const REPHRASE_ACCENT_HEX = "#c099ff"; // --purple-400 (dark)

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
