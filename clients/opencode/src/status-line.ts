export interface StatusLineInput {
    state: "flagged" | "pinned" | "rephrase-loading" | "rephrase-result" | "clear";
    issueCount?: number;
    categories?: string[];
    pinnedIndex?: number;
    nextIssueKey?: string;
    prevIssueKey?: string;
    applyAllKey?: string;
    rephraseKey?: string;
    cycleNextKey?: string;
    cyclePrevKey?: string;
}

/** Category → single-block tick. */
const CATEGORY_TICK: Record<string, string> = {
    spelling: "▁",
    grammar: "▂",
    style: "▃",
    typography: "▄",
    misc: "▅",
    unknown: "▆",
};

/**
 * Build the status-line text from state + bound keys. Pure function —
 * no I/O. Returns a single-line string with dim formatting.
 */
export function buildStatusLine(input: StatusLineInput): string {
    switch (input.state) {
        case "flagged": {
            const ticks = (input.categories ?? [])
                .map((c) => CATEGORY_TICK[c] ?? CATEGORY_TICK.unknown)
                .join("");
            return `▍ ${input.issueCount ?? 0} issues · ${input.nextIssueKey ?? "ctrl+g"} review · ${input.applyAllKey ?? "ctrl+."} apply all · ${input.rephraseKey ?? "ctrl+/"} rephrase  ${ticks}`;
        }
        case "pinned": {
            const idx = input.pinnedIndex ?? 0;
            const total = input.issueCount ?? 0;
            const cn = input.cycleNextKey ?? "ctrl+n";
            const cp = input.cyclePrevKey ?? "ctrl+p";
            return `‹ ${idx}/${total} › · ${cn} ${cp} cycle · return apply · x ignore · esc close`;
        }
        case "rephrase-loading": {
            return "✎ rephrasing…";
        }
        case "rephrase-result": {
            return "⏎ apply · esc reject · ctrl+/ regenerate · ↑↓ cycle";
        }
        case "clear": {
            return "✓ no issues";
        }
    }
}
