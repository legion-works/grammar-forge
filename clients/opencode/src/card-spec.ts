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
