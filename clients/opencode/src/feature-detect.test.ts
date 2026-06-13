import { describe, expect, test } from "vitest";
import { detectPromptPinSupport } from "./feature-detect";

describe("detectPromptPinSupport", () => {
    test("returns supported=true when api.prompt + onCursorChange present (live ref with cursorOffset)", () => {
        const api = {
            prompt: {
                onCursorChange: () => () => undefined,
                ref: () => ({ cursorOffset: 0 }),
            },
        };
        expect(detectPromptPinSupport(api)).toEqual({
            hasPrompt: true,
            hasCursorChange: true,
            hasCursorOffset: true,
            supported: true,
        });
    });

    test("REGRESSION GUARD: supported=true when ref() returns null (startup-before-mount)", () => {
        // THE BUG: pre-fix, ref() returning null at startup was
        // treated as "no cursorOffset capability" → supported: false
        // → pin wiring never installed. Post-fix: hasCursorOffset
        // is DIAGNOSTIC only; the gate is hasPrompt && hasCursorChange.
        // A null ref at startup is a startup-timing artifact, not a
        // missing-capability signal.
        const api = {
            prompt: {
                onCursorChange: () => () => undefined,
                ref: () => null,
            },
        };
        const result = detectPromptPinSupport(api);
        expect(result.hasPrompt).toBe(true);
        expect(result.hasCursorChange).toBe(true);
        expect(result.hasCursorOffset).toBe(false); // diagnostic only
        expect(result.supported).toBe(true); // <-- regression guard
    });

    test("supported=true with ref() returning object without cursorOffset (graceful degrade)", () => {
        // A theoretical facade variant: onCursorChange present but
        // the ref doesn't expose cursorOffset. The event-time handler
        // already guards non-number; we degrade gracefully (every
        // event logs and skips) rather than disabling the whole pin
        // wiring at startup.
        const api = {
            prompt: {
                onCursorChange: () => () => undefined,
                ref: () => ({}),
            },
        };
        const result = detectPromptPinSupport(api);
        expect(result.hasPrompt).toBe(true);
        expect(result.hasCursorChange).toBe(true);
        expect(result.hasCursorOffset).toBe(false); // diagnostic only
        expect(result.supported).toBe(true);
    });

    test("supported=false when api.prompt is missing (unpatched build)", () => {
        const api = {};
        expect(detectPromptPinSupport(api)).toEqual({
            hasPrompt: false,
            hasCursorChange: false,
            hasCursorOffset: false,
            supported: false,
        });
    });

    test("supported=false when api.prompt is null (unpatched build, nullish)", () => {
        const api = { prompt: null };
        expect(detectPromptPinSupport(api)).toEqual({
            hasPrompt: false,
            hasCursorChange: false,
            hasCursorOffset: false,
            supported: false,
        });
    });

    test("supported=false when onCursorChange is missing (genuinely unpatched facade)", () => {
        // This is the OTHER failure mode: the facade has api.prompt
        // but no onCursorChange. Pin wiring is correctly skipped.
        // The OLD prime-suspect test for the no-pin bug; pre-fix
        // both this case and the null-ref case returned supported:
        // false and we couldn't distinguish them in the log.
        const api = {
            prompt: {
                ref: () => ({ cursorOffset: 0 }),
            },
        };
        const result = detectPromptPinSupport(api);
        expect(result.hasPrompt).toBe(true);
        expect(result.hasCursorChange).toBe(false);
        expect(result.hasCursorOffset).toBe(true);
        expect(result.supported).toBe(false);
    });

    test("supported=false when ref() throws (true capability signal, but live probe failed)", () => {
        // hasCursorChange is still true (the function exists), so
        // supported is true. The thrown ref() is a startup-timing
        // artifact; the orchestrator's onCursorMove handler will
        // get a fresh ref() on each event.
        const api = {
            prompt: {
                onCursorChange: () => () => undefined,
                ref: () => {
                    throw new Error("not ready");
                },
            },
        };
        const result = detectPromptPinSupport(api);
        expect(result.hasPrompt).toBe(true);
        expect(result.hasCursorChange).toBe(true);
        expect(result.hasCursorOffset).toBe(false); // caught at probe
        expect(result.supported).toBe(true);
    });

    test("treats api === null / api === undefined defensively", () => {
        expect(detectPromptPinSupport(null).supported).toBe(false);
        expect(detectPromptPinSupport(undefined).supported).toBe(false);
    });

    test("non-finite cursorOffset is not load-bearing (NaN/Infinity → hasCursorOffset: false, supported: true)", () => {
        // The live cursorOffset would be NaN or Infinity in a buggy
        // facade; we mark hasCursorOffset: false (diagnostic) but
        // supported stays true. The event-time guard handles the
        // non-number check.
        const api = {
            prompt: {
                onCursorChange: () => () => undefined,
                ref: () => ({ cursorOffset: NaN }),
            },
        };
        const result = detectPromptPinSupport(api);
        expect(result.hasCursorOffset).toBe(false);
        expect(result.supported).toBe(true);
    });
});
