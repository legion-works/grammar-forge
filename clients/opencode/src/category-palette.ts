// Single source of truth for the category → display-color map.
// Mirrors CATEGORY_META.badge in clients/browser/src/api/category.ts;
// keep the two in sync if the browser palette changes. The badge
// color is the brighter of the two swatches per category and reads
// well as a terminal underline foreground AND a bordered-card
// border foreground on both light and dark backgrounds.
//
// Used by:
//   - orchestrator.ts (extmark underline foreground for the prompt)
//   - tui-entry.tsx (bordered-card border color in the details panel)
//
// New categories must be added here and in the browser's
// CATEGORY_META in lockstep.

export const CATEGORY_FG: Record<string, string> = {
    spelling: "#ef4444",
    grammar: "#eab308",
    punctuation: "#06b6d4",
    style: "#8b5cf6",
    typography: "#6b7280",
    unknown: "#9ca3af",
};

export function categoryColor(category: string): string {
    return CATEGORY_FG[category] ?? CATEGORY_FG.unknown ?? "#9ca3af";
}
