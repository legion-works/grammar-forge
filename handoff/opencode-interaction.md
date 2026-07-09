# GrammarForge OpenCode TUI — Interaction Spec

How the OpenCode plugin should behave. The TUI is **keyboard-first**: every
action is reachable and discoverable from the keyboard without ever touching the
mouse. The mouse is a **secondary accelerator** that mirrors keyboard actions —
never the only path to anything.

Grounded in the current source: `orchestrator.ts` (keymap layers, cursor
hit-test, rephrase state machine), `details-state.ts` (pin model),
`card-spec.ts` / `details-panel.ts` (card view-models), `overlay-anchor.ts`
(card placement). Where this spec diverges from today's behavior it is called
out as **CHANGE** or **NEW**; everything else documents intended behavior that
already exists.

---

## 1. Principles

1. **Keyboard-first, mouse-optional.** The prompt is the focus; GrammarForge is
   an ambient layer over it. No action requires the mouse.
2. **Cursor and pin are coupled.** The terminal text cursor and the "pinned
   suggestion" move together. Reviewing issues *is* moving the cursor — driving
   it by key or by click is the same motion.
3. **Non-modal.** GrammarForge never traps the prompt. With nothing pinned, all
   of the host's normal keys are free; GF's gated keys (`return`, `x`, cycle,
   `esc`) only bind while a card is open.
4. **Discoverable.** The current state always advertises its keys — in the card
   and in a one-line status affordance under the prompt. Never a hidden hotkey.
5. **Quiet.** Underlines + an optional one-line status. No panels, no chrome,
   nothing that competes with the agent transcript.

---

## 2. States

```
IDLE ──type──▶ CHECKING ──results──▶ FLAGGED ──pin──▶ PINNED ──apply/ignore──▶ FLAGGED
  ▲                                     │                  │
  └──────────── all clear ◀─────────────┘         rephrase │ (any state)
                                                           ▼
                                            REPHRASE-LOADING ──▶ REPHRASE-RESULT
```

- **IDLE** — empty/clean prompt. No underlines, no card. Status line hidden.
- **CHECKING** — debounced check in flight (`realtimeDelayMs`, default 500 ms).
- **FLAGGED** — underlines present, nothing pinned. Status line shows the count
  + the review key.
- **PINNED** — one suggestion is focused; its card floats above the word, the
  word is selected, and the cursor sits on it.
- **REPHRASE-LOADING / -RESULT** — the rephrase card owns the overlay; suggestion
  pinning is suppressed until it resolves or is rejected.

---

## 3. Keyboard model (first-class)

### 3.1 Global (always available while the prompt has focus)
| Key | Action | Notes |
|---|---|---|
| **`ctrl+g`** | **NEW — Review: go to next issue.** Pins the next issue after the cursor (wraps), moves the cursor to it, opens its card. Works from anywhere — this is the keyboard entry into review and the fix for "you can only pin by landing the cursor on a word." | repeatable |
| **`ctrl+shift+g`** | **NEW — Review: previous issue.** Symmetric. | repeatable |
| `ctrl+.` | Apply ALL suggestions; toast confirms the count; re-check. | existing |
| `ctrl+/` | Rephrase the whole prompt (→ REPHRASE-LOADING). | existing |

> Today cycle and `return`/`x` only work **once something is already
> pinned** (the details keymap layer is gated on `pinnedIndex !== null`). Without
> `ctrl+g`, the only way to get a first pin is to manually arrow/click the cursor
> onto an underline. `ctrl+g` makes review reachable in one keystroke — the
> single most important keyboard-first change.

### 3.2 While PINNED (gated details layer)
| Key | Action |
|---|---|
| `ctrl+n` / `ctrl+p` | Cycle to next / previous issue (wraps). **Moves the cursor to that word** (`setCursorOffset`) so cursor and pin stay coupled. Readline/emacs-standard; chosen over `.`/`/` because those collide with normal coding-prompt input (paths, method calls). |
| `return` | Apply the pinned suggestion (or its primary replacement). Advance to the next open issue if one remains; else return to FLAGGED/clear. |
| `x` | Ignore the pinned suggestion → `/signal {action:"ignored"}`; drop its underline; advance. |
| `esc` | Unpin (close the card); cursor stays put. |
| `←/→ ↑/↓`, typing | Move the cursor / edit normally. Moving off the word unpins; moving onto another underline pins it (hit-test). Editing re-checks. |

**CHANGE — cursor follows `ctrl+g`/cycle.** Cycling and review-jump must call
`setCursorOffset(span.start)` (cycle already does; `ctrl+g` must too) so the
selected word, the card anchor, and the caret never diverge.

### 3.3 While REPHRASE-RESULT
| Key | Action |
|---|---|
| `return` | Apply the rephrase (replace whole prompt). |
| `esc` | Reject; restore the original; back to FLAGGED. |
| **`ctrl+/`** | **NEW — Regenerate** (request another rephrase of the same text). |
| **`↑/↓` or `tab`** | **NEW — cycle alternatives** when the bridge returns more than one (`/rephrase` can return N). Show `‹ k/n ›` in the card. |
| **`PgUp/PgDn`** | **NEW — scroll** when the wrapped text exceeds the card's max height (see §5). |

### 3.4 Conventions
- All keys are **rebindable** via plugin options (`applyAllHotkey`,
  `cycleNextHotkey`, `cyclePrevHotkey`, `rephraseHotkey`, and **NEW**
  `nextIssueHotkey` / `prevIssueHotkey`). The card's hint line always renders the
  *actually bound* keys (it already threads `cycleNextKey`/`cyclePrevKey`).
- GF never overrides a host key while idle; gated layers keep `return`/`x`/`esc`
  free for the host until a card is open.

---

## 4. Mouse model (secondary accelerator)

Every mouse action has a keyboard equivalent; the mouse only ever saves
keystrokes.

| Gesture | Action | Keyboard equivalent |
|---|---|---|
| **Click an underline** | Pin that issue (moves caret there → same `onCursorChange` hit-test path that already exists). | `ctrl+g` to it |
| **Click the card's diff row** | Apply the pinned suggestion. | `return` |
| **Click `apply` / `ignore` words** in the hint row (NEW: render them as discrete clickable spans) | Apply / ignore. | `return` / `x` |
| **Scroll wheel over a tall rephrase card** | Scroll the wrapped text. | `PgUp/PgDn` |
| **Click an alternative** in a multi-option rephrase | Select it. | `↑/↓` |
| **Click outside the card / underlines** | Dismiss (unpin / reject rephrase). | `esc` |

Mouse notes:
- Hit areas are whole cells; the card's clickable rows must be ≥1 row tall and
  not overlap the prompt input.
- Don't rely on hover — terminal hover is unreliable and noisy. Pin/preview is
  click-driven, matching the keyboard's explicit-pin model.
- Mouse must degrade gracefully: terminals without mouse reporting lose nothing
  because every action is on the keyboard.

---

## 5. Rephrase card — fix the truncation (NEW)

**Today:** `card-spec.ts` does `truncateText(text, 40)` and renders the original
and rephrased each on a single 40-col line, cutting everything past 39 chars to
`…`. A real rephrase ("In hindsight we should have merged the fix last week…") is
unreadable — you can't judge a suggestion you can't see.

**Required behavior — wrap, don't truncate:**
1. **Word-wrap** the original and rephrased text to the card's inner width
   (`CARD_W − 2 border − 2 padding = 40` cols), using display width
   (`displayWidthOf`, grapheme + wide-char aware — never `string.length`).
2. **Grow the card height** to fit the wrapped lines, up to a **max of 8 content
   rows total** (original + rephrased + hints). `overlay-anchor.clampAnchor`
   already flips the card below the word when there's no room above — pass the
   grown `cardH` so placement stays correct.
3. If the content still exceeds the max, **scroll** the body (`PgUp/PgDn`, wheel)
   and show a dim ` ↓ more ` affordance on the last visible row — do **not** drop
   text.
4. Visual layout (wrapped):
   ```
   ┌─ style ──────────────────────────────────┐
   │ ✎ Rephrase                                │
   │ In hindsight we should have merged the    │   ← original, dim, wrapped
   │ fix last week.                            │
   │  → We should have merged the fix last     │   ← rephrased, green, wrapped
   │    week.                                   │
   │ ⏎ apply · esc reject · ctrl+/ regenerate  │   ← hints reflect bound keys
   └────────────────────────────────────────────┘
   ```
5. The same wrap helper should back the **suggestion** card's diff row when a
   replacement is long (rare, but today it would also overflow a single line).

**Acceptance:** a 25-word rephrase shows in full (wrapped, scroll if needed);
nothing is replaced by `…` unless it exceeds the 8-row cap, and then only the
overflow is scrolled, never lost.

---

## 6. Status-line affordance (NEW, keyboard-first discoverability)

A single dim line under the prompt, shown only when there's something to act on:

- **FLAGGED:** `▍ 8 issues · ctrl+g review · ctrl+. apply all · ctrl+/ rephrase`
  with a tiny category-color tick row (e.g. ▁ per category present).
- **PINNED:** the card already shows per-issue hints; the status line can dim to
  just `‹ 3/8 ›`.
- **REPHRASE:** `✎ rephrasing…` / `⏎ apply · esc reject`.
- **clear:** `✓ no issues` then fade.

This is the single place a new user learns the review key without reading docs.

---

## 7. Edge cases (keep current behavior)
- **Paste / file / agent-mention ranges** are never flagged (`part-filter`,
  `paste-mask`). A `ctrl+g` review skips them for free (they aren't items).
- **Send / clear** with open issues logs them `ignored` (existing).
- **Bridge unreachable** → silent idle; resumes on next edit. `ctrl+g` with no
  items is a no-op (optionally a dim "no issues" toast).
- **Route remount / ref swap** cancels in-flight rephrase and clears pins
  (existing seq/ref guards).
- **Stale pin** (re-check changed the pinned item's identity) clears the pin
  (`details-state` signature check).

---

## 8. Implementation checklist
- [ ] **NEW** `grammarforge.review.next` / `.prev` commands, bound `ctrl+g` /
      `ctrl+shift+g`, in an **ungated** layer (work from FLAGGED, not just
      PINNED). Each pins the next/prev item *relative to the cursor* and calls
      `setCursorOffset(span.start)`.
- [ ] **CHANGE** remap default cycle keys from `.`/`/` to **`ctrl+n` / `ctrl+p`**
      (`cycleNextHotkey` / `cyclePrevHotkey` defaults) — `.`/`/` collide with
      normal coding-prompt input. The card hint + status line render the bound keys.
- [ ] **CHANGE** make `ctrl+g`/cycle move the cursor (cycle already does).
- [ ] **NEW** `nextIssueHotkey` / `prevIssueHotkey` settings (default `ctrl+g` /
      `ctrl+shift+g`); thread bound labels into the status line + hints.
- [ ] **FIX** `card-spec.ts`: replace `truncateText` with a display-width
      word-wrap; grow `cardH`; pass it to `clampAnchor`; add scroll + ` ↓ more `.
- [ ] **NEW** rephrase: regenerate (`ctrl+/`), alternative cycling (`↑/↓`/`tab`)
      with `‹ k/n ›`, body scroll (`PgUp/PgDn`).
- [ ] **NEW** status-line slot under the prompt (count + bound review/apply/
      rephrase keys + category ticks).
- [ ] **NEW** mouse: clickable card rows (apply/ignore), click-out dismiss,
      wheel scroll — all mirroring keys, all degrading gracefully.
- [ ] Keep every existing guard (seq, ref-swap, stale-pin, part ranges).
