# GrammarForge — Interaction & State Flows

Every flow below is implemented and verified in the two reference DCs
(`GrammarForge Assistant.dc.html`, `GrammarForge Vencord.dc.html`). This file is
the behavioral spec; the SCSS/markup are the visual spec.

---

## 0. Core model

A **suggestion** (from the bridge `/correct` response) carries:
`{ id, start, end, original, replacements[], category, confidence (0–1), model, message }`
— where `model ∈ {harper, gector, lt_rule, llm}` and `category ∈ {spelling,
grammar, punctuation, style, typography}`.

Per-field UI state:
- `status[id] = open | accepted | dismissed`
- `chosen[id] = <applied replacement string>`
- `focusId` — the single issue currently hovered **or** whose card is open
  (drives the `.is-on` underline tint).
- `phase = fast | done` — streaming stage (see §2).
- `goals = { audience, formality, domain }`
- `dictWords[]`, `panelView = review | stats`

Derived: `visible()` = open suggestions that are **live** (AI ones only after
`phase==='done'`) **and** not muted by goals. `score = 100 − Σ penalty(cat)`
over visible. Bands: ≥90 Excellent, ≥78 Good, ≥60 Fair, else Needs-work.

---

## 1. Check-as-you-type  (the always-on loop)

```
user types ──▶ debounce 480ms ──▶ /correct (or local rules in demo)
                                   │
   instant: render underlines for harper+gector  (phase=fast)
                                   │  ~650ms later
   settle:  add llm suggestions, recolor          (phase=done)
```
- Underlines reflow on every keystroke (no debounce) so the marker never lags
  the caret; the *network check* is debounced.
- Pasted text is only checked if `checkPastedText` is on.

## 2. Streaming fast → slow  (the differentiator)

The bridge `/correct/stream` returns fast frames then a final LLM frame.
- While `phase==='fast'`: entry point shows a pulsing **AI pip**; panel shows a
  `✨ Fast results in · AI refining…` banner; a scan-line sweeps the field.
- On the final frame (`phase==='done'`): AI suggestions fade in (`gf-ailand`),
  score drops to include them, pip → count/check.

## 3. Hover a word → preview pill

```
mousemove over field ─▶ hit-test pointer vs underline rects
   hit & id changed ─▶ MEASURE word rect ─▶ set focusId ─▶ re-render underlay
                        ─▶ show .gf-tip (diff only) above the word
   no hit ─▶ clear focusId + hide pill
```
⚠️ **Order matters:** measure the word rect *before* re-rendering the underlay.
Re-rendering replaces the span nodes; a detached node returns a zero rect and
the pill is positioned off-screen. (This was a real bug — see INSTRUCTIONS §5.)

The pill is **preview-only** (diff, no buttons) in production — it mirrors the
real clients' tooltip. `pointer-events:none`.

## 4. Click a word → correction card

```
click underline ─▶ hit-test ─▶ openCard(id)
   set focusId=id (word stays tinted) ─▶ measure word rect
   ─▶ position card anchored to the word (tail points at it; flips above/below
      to stay on-screen)
```
Card contents & actions:
- **Accept** (`Enter`) → apply `chosen ?? replacements[0]`, `status=accepted`,
  flash the resolved text green, toast **Accepted** + Undo, advance focus.
- **Alternative chip** → accept with that specific replacement.
- **Dismiss** → `status=dismissed`, fire `/signal {action:'rejected'}`, toast
  **“Won’t flag this again” + Undo**. (This is the learning loop made visible.)
- **Add to dictionary** (spelling only) → push word to `dictWords`, `/dictionary`
  POST, re-scan, toast + Undo.
- **Nav** `‹ N of M ›` / `←` `→` cycle open issues; `Esc` closes.

## 5. Bulk actions (panel)

- **Accept all N** → apply every visible suggestion (right-to-left so offsets
  stay valid), single Undo restores all.
- **Accept high-confidence only** → apply just `confidence ≥ 0.90`, leave
  judgment calls. Shown only when `0 < highConf < total`.
- **Accept all <category>** → per-group bulk accept.
- All bulk actions land in one toast with batch Undo.

## 6. Score orb / chatbar entry point

| State | Browser orb | Vencord badge |
|---|---|---|
| issues > 0 | open count, arc = band color | numeric badge |
| AI refining | pulsing ✨ pip | pulsing ✨ pip |
| all clear | ✓ check, green arc, celebrate pulse | green check dot |
| disabled on site | muted power glyph | (pill hidden / paused) |

Click → toggle panel. Panel expands from the orb corner
(`transform-origin: 100% 100%`).

## 7. Goals  (Grammarly-style intent)

`Goals` pill in the panel header → popover with **Audience / Formality /
Domain** segmented controls.
- `formality = informal` ⇒ style suggestions are muted: their underlines vanish,
  they leave the count/score, and a dashed **“N style suggestions muted by your
  goals”** note appears with a shortcut back to Goals.
- `formality` also seeds the default rephrase tone (formal→Formal, informal→Casual).

## 8. Rephrase  (Wordtune-style)

```
selection or ✨ button ─▶ rephrase card
   scope:  This sentence | Whole message
   tone:   Neutral | Formal | Casual (| Friendly)
   ─▶ loading: spinner "Generating with Gemma…" + 2 skeleton blocks
   ─▶ /rephrase returns N alternatives ─▶ click one ─▶ replace text + toast+Undo
   ─▶ Regenerate re-requests the same scope/tone
```

## 9. Synonyms

Double-click any **non-flagged** word → `/synonyms` (or thesaurus) → small menu
anchored under the word; pick one to swap in place (Undo via toast).

## 10. Stats  (retention surface)

Panel **Stats** tab (`/stats`): words-this-week, suggestions checked,
acceptance rate, day-streak, top-issue bars, and the **personal dictionary**
with removable chips (`/dictionary` DELETE). “Computed locally — nothing leaves
your machine.”

## 11. Disable / pause

- Per-site disable from the panel footer or popup. When disabled: underlines
  off, checks paused, editor renders plain text, orb → power glyph, panel shows
  a **Paused** empty-state with a “Turn on for this site” button.
- Maps to `blockedSites` in settings.

---

## Keyboard summary
| Key | Context | Action |
|---|---|---|
| `Enter` | card open | Accept current |
| `← / →` | card open | Prev / next issue |
| `Esc` | card / popover | Close |
| `Alt + .` | field focused | Accept first suggestion (configurable) |
| `Ctrl + /` | field focused | Rephrase (configurable) |
