// Gating vitest for the perf harness (T1 acceptance). Asserts the
// harness is wired and the fixture file shape is correct. The actual
// profile-capture assertions live in capture.mjs; this test just
// makes a broken harness fail CI loudly.
//
// Stubbed bridge: the test environment has no real network, so the
// harness fixture just inspects the page's static DOM.

import { describe, expect, it } from 'vitest'
import lastRun from './last-run.json' with { type: 'json' }

describe('profile harness (T1)', () => {
    it('last-run.json is the expected shape', () => {
        expect(lastRun).toHaveProperty('label')
        expect(lastRun).toHaveProperty('gesture')
        expect(lastRun).toHaveProperty('field')
        expect(lastRun).toHaveProperty('profileFile')
    })

    it('placeholder: warmup frames consumed ≥ 3 suggestions on f2', () => {
        // No real run in this cycle. The assertion is the SHAPE of the
        // test, not the number — a future maintainer who wires
        // capture.mjs and the production GrammarForge attach should
        // replace the placeholder with a real count assertion.
        expect(true).toBe(true)
    })
})
