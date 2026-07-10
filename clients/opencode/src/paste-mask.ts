// paste-mask.ts — mask paste placeholder text before sending to the bridge.
//
// OpenCode replaces large pastes (>=3 lines or >150 chars) with a placeholder
// token like `[Pasted ~5 lines]` in ref.text. The real pasted content lives in
// part.text and never enters ref.text. This module replaces each placeholder
// with an equal-length run of spaces so the bridge sees neutral whitespace
// instead of the placeholder string — "only typed text is checked" is literally
// true at the bridge boundary.
//
// COORDINATE-SPACE RULE: the mask operates on ref.text, a UTF-16 JS string.
// source.text.{start,end} may or may not be UTF-16 code-unit offsets into that
// string. We self-verify per part:
//   - If text.slice(start, end) === value → offsets are code-unit → mask [start,end).
//   - Otherwise → fall back to text.indexOf(value) and mask all occurrences.
// Equal-length replacement (value.length spaces) preserves all downstream
// offsets and extmarks — no offset remapping needed.
//
// P0-2 FIX: the working buffer MUST be indexed by UTF-16 code unit, matching
// `start`/`end` (verified above via `text.slice`). `Array.from(text)` iterates
// by UNICODE CODE POINT — it collapses a surrogate pair (e.g. an emoji outside
// the BMP) into a single array element. Any astral character appearing BEFORE
// a placeholder then shifts every subsequent code-unit index left by one per
// astral char, so `chars[i] = " "` masks the wrong window and `chars.join("")`
// comes back SHORTER than `text` — tripping the length-mismatch guard in
// orchestrator.ts, which (pre-fix) fell back to sending the ORIGINAL UNMASKED
// text to the bridge. `text.split("")` splits by UTF-16 code unit (surrogate
// halves stay separate elements), keeping indices aligned with `start`/`end`.

import type { PromptPart } from "./opencode-types";

/**
 * Replace paste placeholder text in `text` with equal-length spaces.
 *
 * Only `type === "text"` parts with a non-empty `source.text.value` are
 * considered. Parts without `source.text` (file, agent, plain text parts)
 * are left untouched.
 *
 * The returned string is ALWAYS the same length as `text`.
 */
export function maskPastePlaceholders(text: string, parts: ReadonlyArray<PromptPart>): string {
    if (parts.length === 0 || text.length === 0) return text;

    // Work on a char array so we can do in-place range fills efficiently.
    // We only allocate if at least one part actually needs masking.
    let chars: string[] | null = null;

    for (const part of parts) {
        // Only text parts with source.text carry paste placeholders.
        if (part.type !== "text") continue;
        const sourceText = part.source?.text;
        if (!sourceText) continue;

        const { start, end, value } = sourceText;
        // Skip empty values — nothing to mask.
        if (!value) continue;

        // Lazy-allocate the char array on first actual mask operation.
        // UTF-16 code units (NOT Array.from's code-point iteration) — see
        // the P0-2 note above.
        if (chars === null) {
            chars = text.split("");
        }

        // Self-verify: are start/end UTF-16 code-unit offsets into text?
        if (text.slice(start, end) === value) {
            // Offsets are code-unit — mask [start, end) directly.
            for (let i = start; i < end; i++) {
                chars[i] = " ";
            }
        } else {
            // Offsets are NOT code-unit into ref.text; fall back to indexOf.
            // Replace ALL occurrences (there should be exactly one, but be safe).
            let pos = text.indexOf(value);
            while (pos !== -1) {
                for (let i = pos; i < pos + value.length; i++) {
                    chars[i] = " ";
                }
                pos = text.indexOf(value, pos + value.length);
            }
            // If value is not found at all, skip (mask nothing, never throw).
        }
    }

    if (chars === null) return text;
    return chars.join("");
}
