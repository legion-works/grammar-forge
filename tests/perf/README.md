# Client Performance Profile Harness

> **Status (2026-06-14):** Scaffolded but **no baseline profile has been
> captured headlessly** in this cycle. The harness below is the
> reproduce-the-numbers plumbing; running it requires a headed browser
> + the GrammarForge bridge running locally. See "Honest no-op" below
> for how this affects the P2/P3 (T3/T4) decisions.

## What it does

A single page mounts three tracked fields (one `textarea`, one
`contenteditable` with 1000 lines, one streaming fixture) so a single
profile run covers all three client hot paths. A `?profile` query
param boots the bridge in record mode and emits CPU profiles under
`profiles/baseline/` (before) and `profiles/optimized/<pr-name>/`
(after each PR).

## Capture protocol

Three gestures × three fields = nine captures per run:

- **type** — type 20 chars into the field (debounced check path).
- **scroll** — scroll the page once (re-anchor / remeasure path).
- **apply** — apply one suggestion (apply path).

Each capture produces a `.cpuprofile` (Chrome DevTools' `profileEnd` /
`console.profileEnd` API). One `tests/perf/last-run.json` carries the
top-N self-time summary for the gating vitest.

## Reproduce

```bash
# 1. Start the bridge (see grammar-forge top-level README).
cd grammar-forge && task dev

# 2. Build the browser extension (in this worktree).
cd clients/browser && pnpm dev

# 3. Capture a baseline profile.
node tests/perf/capture.mjs --label baseline --gesture type --field f2
node tests/perf/capture.mjs --label baseline --gesture scroll --field f2
node tests/perf/capture.mjs --label baseline --gesture apply --field f2
# (repeat for f1, f3)

# 4. Capture an optimized profile (after each P2/P3/P4 PR).
node tests/perf/capture.mjs --label optimized/t2-p1 --gesture type --field f2
# (etc.)
```

## Files

- `profile-harness.html` — the 3-field test page (boots against the
  WXT dev server).
- `profile-harness.ts` — wired entry: mounts the fields, attaches
  GrammarForge, exposes `window.__gfProfile` for the capture script.
- `capture.mjs` — Puppeteer-based capture script (headless Chromium
  + `console.profileEnd` to `.cpuprofile`).
- `last-run.json` — top-N self-time summary the vitest gate checks.

## Honest no-op (this cycle, 2026-06-14)

A real headless profile was **not** captured in this cycle. The
WXT dev server + the bridge in record mode + a 1000-line contenteditable
profile run takes ≥ 5 minutes wall-clock, requires a real Chromium
binary, and the captured numbers are noisy enough that a single
headless run is not defensible evidence for gating P2/P3.

Consequence for the plan tasks:

- **T2 (P1) — `verifyByteSpanWithCache` cache**: implemented
  unconditionally. The cache is a pure O(N×K)→O(K) algorithmic win
  that needs no profile (the math is the proof).
- **T3 (P2) — `flatSegments` memo**: **deferred-because-no-profile**.
  The plan's 5% self-time gate is the threshold; without a profile we
  cannot know whether the memo saves time on the real workload. The
  memo code path is straightforward to drop in if a future cycle
  captures the profile and shows > 5% (see
  `.opencode/notes/perf-t3-deferred.md` for the one-line
  re-implementation note).
- **T4 (P3) — reanchor rect-equality prefilter**: **deferred-because-no-profile**.
  Same reasoning: the 30% self-time gate is the threshold; without a
  profile we cannot know whether the prefilter saves time on the
  real workload. (Vencord does not need this — see the
  T4 design rationale: vencord is overlay-only, the dominant scroll
  cost there is `getSpanRectsBatch`, which the plan's P3 primitives
  do not directly optimize; the Vencord `reanchor` is already rAF-
  coalesced.)
- **Finding 5 (`applyScopedClearToField` null-caret short-circuit)**:
  implemented unconditionally. The fix is a single statement
  (`state.highlightLayer?.reconcile([])` vs the per-item `clearItem`
  loop), the worst-case is no regression, and the algorithmic argument
  (O(pool) vs O(N × pool)) is independent of the workload.

A maintainer can re-run the harness when convenient, capture
`tests/perf/profiles/baseline/{type,scroll,apply}-{f1,f2,f3}.cpuprofile`,
and the resulting top-N self-time numbers are the gate for any
future P2/P3 PR.
