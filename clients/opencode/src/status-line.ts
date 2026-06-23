/** Status-line state discriminated union. */
export type StatusLineState =
    | { kind: "flagged"; issueCount: number; categories: string[] }
    | { kind: "pinned"; issueCount: number; pinnedIndex: number; pinnedTotal: number }
    | { kind: "rephrase-loading" }
    | { kind: "rephrase-result" }
    | { kind: "clear" };

export interface StatusLineKeys {
    nextIssueKey: string;
    prevIssueKey: string;
    applyAllKey: string;
    rephraseKey: string;
    cycleNextKey: string;
    cyclePrevKey: string;
}

export interface StatusLineInput {
    state: "flagged" | "pinned" | "rephrase-loading" | "rephrase-result" | "clear";
    issueCount?: number;
    categories?: string[];
    pinnedIndex?: number;
    nextIssueKey?: string;
    applyAllKey?: string;
    rephraseKey?: string;
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
            return `‹ ${idx}/${total} › · ctrl+n ctrl+p cycle · return apply · x ignore · esc close`;
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
