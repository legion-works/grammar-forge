// Process-monotonic counter for the per-field checkSeq used by both
// orchestrators' async-bridge race guard. Initialising checkSeq from a
// counter shared by the whole process (instead of `0` per field) means a
// pending bridge call from a DETACHED field state can never alias a
// re-attached field's seq — the re-attached field starts at a value
// strictly greater than any seq a torn-down field ever produced.
//
// The counter is module-level (a single `let` shared by every importer
// within the content script). The browser extension and the Vencord
// plugin each bundle their own copy of this module (separate JS realms),
// so the counter never crosses realm boundaries; within a single realm
// it is monotonic for the script's lifetime.

let __monotonic = 0

/**
 * Return a fresh, never-before-seen, strictly-greater-than-every-prior
 * value. Consumed at field-attach time to initialise FieldState.checkSeq;
 * each rerunFor call then does `seq = ++state.checkSeq` as before, so the
 * per-field seq counter advances and the race guard (seq !== state.checkSeq)
 * keeps working as it always did.
 */
export function nextCheckSeq(): number {
    __monotonic += 1
    return __monotonic
}
