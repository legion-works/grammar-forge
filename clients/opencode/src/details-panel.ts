// Pure view-model for the suggestion-details panel. The tui-entry
// component consumes `buildDetailsViewModel(item, index, total)` to
// render the bordered card (title / diff / hints) for whatever is
// pinned. The view-model is pure data; the JSX is in tui-entry.tsx.
//
// Display shape (post-fix, "Bordered card" style):
//   title  : "✎ {category} {index+1}/{total}" — category-colored (the
//             "✎" is a hint symbol; the category label uses the
//             same color for visual continuity with the underline).
//   diff   : "<original> → <replacement>" with three modes:
//             - normal:   "abc → def"
//             - deletion: "abc → ∅" (replacement is empty)
//             - insertion: "∅ → def" (original is empty)
//             The diff ships as THREE pre-rendered strings (left,
//             arrow, right) so the bun-only renderer can color
//             left=red, arrow=dim, right=green without re-parsing.
//   hints  : "⏎ apply · x ignore · n/p cycle · esc close"
//
// Categories mirror CATEGORY_META in clients/browser/src/api/category.ts;
// the COLORS are in ./category-palette.ts (single source of truth for
// both underline foreground and card border).

import type { Category } from "@/api/types";
import { categoryColor } from "./category-palette";

export const CATEGORY_LABEL: Record<Category, string> = {
    spelling: "Spelling",
    grammar: "Grammar",
    punctuation: "Punctuation",
    style: "Style",
    typography: "Typography",
    unknown: "Issue",
};

export type DiffMode = "normal" | "deletion" | "insertion";

export interface DetailsViewModel {
    /** Card title, e.g. "✎ grammar 2/3". categoryColorKey tells the
     *  renderer which color to apply to the category label. */
    title: string;
    categoryLabel: string;
    categoryColorKey: string;
    /** Pre-formatted index piece for the title row, e.g. " 2/3".
     *  The renderer can place it next to the category label with
     *  a dim color. The card-spec uses these directly so the
     *  renderer stays dumb. */
    indexPlusOne: number;
    total: number;
    /** Three pre-rendered strings: the original (or "∅"), the
     *  arrow, the replacement (or "∅"). Renderer can color
     *  independently. The mode tells the renderer which color slot
     *  each piece gets. */
    diffLeft: string;
    diffArrow: string;
    diffRight: string;
    diffMode: DiffMode;
    hints: string;
    /** The full text (debug / accessibility). */
    fullText: string;
}

export interface DetailsItemInput {
    category: string;
    original: string;
    replacement: string;
    isDeletion?: boolean;
}

export function buildDetailsViewModel(
    item: DetailsItemInput,
    index: number,
    total: number,
): DetailsViewModel {
    const categoryLabel =
        CATEGORY_LABEL[(item.category as Category) ?? "unknown"] ?? CATEGORY_LABEL.unknown;
    const title = `✎ ${categoryLabel} ${index + 1}/${total}`;
    const categoryColorKey = categoryColor(item.category);
    // Three diff modes. The renderer uses `diffMode` to choose which
    // color slot gets the focus color (red for "will-change-to",
    // green for "change-to").
    let diffMode: DiffMode;
    let diffLeft: string;
    let diffRight: string;
    if (item.isDeletion === true || (item.original !== "" && item.replacement === "")) {
        diffMode = "deletion";
        diffLeft = item.original;
        diffRight = "∅";
    } else if (item.original === "" && item.replacement !== "" && !item.isDeletion) {
        diffMode = "insertion";
        diffLeft = "∅";
        diffRight = item.replacement;
    } else {
        diffMode = "normal";
        diffLeft = item.original;
        diffRight = item.replacement;
    }
    const diffArrow = " → ";
    const hints = "⏎ apply · x ignore · n/p cycle · esc close";
    const fullText = [title, `${diffLeft}${diffArrow}${diffRight}`, hints].join("\n");
    return {
        title,
        categoryLabel,
        categoryColorKey,
        indexPlusOne: index + 1,
        total,
        diffLeft,
        diffArrow,
        diffRight,
        diffMode,
        hints,
        fullText,
    };
}
