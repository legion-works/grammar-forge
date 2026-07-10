// P0-2 (second half): if maskPastePlaceholders ever produces output whose
// length doesn't match the input (the defensive invariant it documents but
// — pre-fix — didn't always uphold for astral input), the orchestrator must
// FAIL CLOSED: skip the bridge call entirely rather than falling back to
// sending the ORIGINAL, UNMASKED text. Sending unmasked text is exactly the
// leak masking exists to prevent.
//
// This is isolated in its own file (rather than orchestrator.test.ts) so the
// vi.mock("./paste-mask", …) below only affects this file's module graph —
// vitest gives each test file its own module registry, so mocking here can't
// bleed into orchestrator.test.ts's real-mask assertions.

import { describe, expect, test, vi } from "vitest";

vi.mock("./paste-mask", () => ({
    // Deliberately broken: returns a SHORTER string than the input, simulating
    // the pre-fix code-point/code-unit misalignment bug (or any future
    // regression that reintroduces a length mismatch).
    maskPastePlaceholders: (text: string) => text.slice(0, Math.max(0, text.length - 1)),
}));

import { startOrchestrator, type OrchestratorDeps } from "./orchestrator";

describe("paste-mask fail-closed (P0-2)", () => {
    test("length mismatch → correctFn is NOT called (no unmasked text ever reaches the bridge)", async () => {
        const correctCalls: Array<{ text: string }> = [];
        const text = "Hello [Pasted ~5 lines] world";
        const ref = {
            text,
            current: {
                input: text,
                parts: [
                    {
                        type: "text" as const,
                        source: { text: { start: 6, end: 24, value: "[Pasted ~5 lines]" } },
                    },
                ],
            },
            cursorOffset: 0,
            extmarks: {
                registerType: () => 1,
                create: () => 1,
                getAllForTypeId: () => [],
                delete: () => true,
            },
            getTextRange: (s: number, e: number) => text.slice(s, e),
            replaceRange: () => undefined,
            focus: () => undefined,
        };

        const api = {
            prompt: {
                ref: () => ref,
                onChange: () => () => undefined,
                onCursorChange: () => () => undefined,
            },
            keymap: { registerLayer: () => () => undefined },
            ui: { toast: () => undefined },
            theme: { syntax: () => ({ registerStyle: () => 1, getStyleId: () => 1 }) },
            lifecycle: { onDispose: () => () => undefined },
        } as unknown as Parameters<typeof startOrchestrator>[0];

        const stop = startOrchestrator(api, { realtimeDelayMs: 5 }, {
            correct: (req: { text: string }) => {
                correctCalls.push({ text: req.text });
                return new Promise(() => undefined); // never resolves — we only check the call happened
            },
        } as unknown as OrchestratorDeps);

        // Wait past the debounce — runCheck fires and hits the mismatch branch.
        await new Promise((r) => setTimeout(r, 30));

        // FAIL CLOSED: the bridge is never called with the (unmasked) text —
        // the mismatch guard returns before reaching correctFn.
        expect(correctCalls).toHaveLength(0);

        stop();
    });
});
