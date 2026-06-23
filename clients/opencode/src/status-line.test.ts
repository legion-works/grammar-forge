import { describe, expect, test } from "vitest";
import { buildStatusLine, type StatusLineInput } from "./status-line";

describe("buildStatusLine", () => {
    test("FLAGGED: shows count + review/apply/rephrase keys + category ticks", () => {
        const input: StatusLineInput = {
            state: "flagged",
            issueCount: 8,
            categories: ["spelling", "grammar", "style"],
            nextIssueKey: "ctrl+g",
            applyAllKey: "ctrl+.",
            rephraseKey: "ctrl+/",
        };
        const result = buildStatusLine(input);
        expect(result).toContain("8 issues");
        expect(result).toContain("ctrl+g review");
        expect(result).toContain("ctrl+. apply all");
        expect(result).toContain("ctrl+/ rephrase");
    });

    test("PINNED: shows index/total", () => {
        const input: StatusLineInput = {
            state: "pinned",
            issueCount: 8,
            pinnedIndex: 3,
            categories: [],
            nextIssueKey: "ctrl+g",
            applyAllKey: "ctrl+.",
            rephraseKey: "ctrl+/",
        };
        const result = buildStatusLine(input);
        expect(result).toContain("‹ 3/8 ›");
    });

    test("REPHRASE-LOADING: shows spinner", () => {
        const input: StatusLineInput = { state: "rephrase-loading" };
        const result = buildStatusLine(input);
        expect(result).toContain("rephrasing…");
    });

    test("REPHRASE-RESULT: shows accept/reject", () => {
        const input: StatusLineInput = { state: "rephrase-result" };
        const result = buildStatusLine(input);
        expect(result).toContain("apply");
        expect(result).toContain("reject");
    });

    test("clear: shows no issues", () => {
        const input: StatusLineInput = { state: "clear" };
        const result = buildStatusLine(input);
        expect(result).toContain("no issues");
    });
});
