export interface StatusLineInput {
    state: "flagged" | "pinned" | "rephrase-loading" | "rephrase-result" | "completion" | "clear";
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
            // Terse: this status shares the prompt's footer row with the model
            // line, so a long string wraps and mangles the model line. Keep the
            // glanceable signal (count + category ticks) plus the ONE action you
            // can take without pinning (apply-all). The full key hints live on
            // the suggestion card, which appears on pin/cursor-rest.
            const ticks = (input.categories ?? [])
                .map((c) => CATEGORY_TICK[c] ?? CATEGORY_TICK.unknown)
                .join("");
            const n = input.issueCount ?? 0;
            const noun = n === 1 ? "issue" : "issues";
            return `▍ ${n} ${noun} · ${input.applyAllKey ?? "ctrl+."} fix all  ${ticks}`;
        }
        case "pinned": {
            // Terse for the same reason — the pinned card directly above shows
            // the full "return apply · x ignore · esc close" hints, so the status
            // only needs the position + cycle keys.
            const idx = input.pinnedIndex ?? 0;
            const total = input.issueCount ?? 0;
            const cn = input.cycleNextKey ?? "ctrl+n";
            const cp = input.cyclePrevKey ?? "ctrl+p";
            return `‹ ${idx}/${total} › · ${cn} ${cp} cycle`;
        }
        case "rephrase-loading": {
            return "✎ rephrasing…";
        }
        case "rephrase-result": {
            return "⏎ apply · esc reject · ctrl+/ regenerate · ↑↓ cycle";
        }
        case "completion": {
            return "✎ completion ready · ⇧Tab accept · esc dismiss";
        }
        case "clear": {
            return "✓ no issues";
        }
    }
}
