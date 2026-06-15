// The W2b review panel — the full per-field review surface that the orb's
// `onOpen` opens. Replaces the W1 hover panel (.gf-pill-panel, retired
// in W2b) and the W1 popover card. One per shadow root (the orchestrator
// owns the open/close lifecycle; a new showPanel() dismisses the prior).
//
// Sections (matches `markup.html §4` + the reference DC panel render
// lines 730-829):
//   - head: logo, title, Goals pill (→ onOpenGoals), recheck, close
//   - tabs: Review / Stats (Stats is a W2-4 stub — only Review is wired)
//   - streaming banner (only while phase === 'fast')
//   - score: SVG ring (r=24.5/dasharray=153.9, color from band) +
//     band label + suggestion count
//   - insights: Tone (static 'Confident' + 'Warm' decorative tags) +
//     Readability + Words + Read-time — from `makeInsights(text)`
//   - bulk actions: "Accept all N" (always when items > 0) +
//     "Accept N high-confidence" (only when 0 < high < total, view-model
//     rule) + "✨ Rephrase message" (when onRephrase is supplied)
//   - grouped list: one group per category with a visible item; per-group
//     "Accept all" chip + per-row diff + source chip; clicking a row
//     fires `onAcceptItem` (orchestrator focuses that suggestion in the
//     field and closes the panel)
//   - footer: "✨ Learns your style" + "Disable on this site"
//   - hidden note: dashed "N style suggestions muted by your goals" when
//     `mutedStyleCount > 0` (the muted STYLE items stay in the live list
//     visually, the count is informational)
//
// Score/insights/grouping math comes from the view-model + the local
// `panel-model.ts` builder — this file is the render layer ONLY. No
// network, no recomputation, no domain math.

import { diffInnerHTML } from '@/overlay/diff-view'
import { installOutsideDismiss, type OutsideDismissHandle } from '@/overlay/dismiss'
import type { Category, Goals, Phase } from '@/api/types'
import { buildPanelModel, type PanelModel } from '@/overlay/panel-model'
import type { RenderableItem } from '@/lib/pipeline'

const SVG_NS = 'http://www.w3.org/2000/svg'

export interface PanelOptions {
    /** Viewport rect of the orb the panel expands from (caller-measured
     *  BEFORE mounting — see INSTRUCTIONS §5: a detached node returns a
     *  zero rect and the panel flies off). The panel anchors to the
     *  bottom-right of the rect. */
    anchorRect: DOMRect
    /** Raw (unfiltered) field items. The panel runs `visibleItems`
     *  internally so the score, list, and the inline count agree. */
    items: readonly RenderableItem[]
    /** Field text — drives the Insights row (words / readability /
     *  read-time). */
    text: string
    /** User goals — drives the visible filter (informal mutes style) +
     *  the muted note + the Goals pill label. */
    goals: Goals
    /** Streaming phase — `fast` shows the banner + the score may be
     *  incomplete (LLM items not yet visible). */
    phase: Phase
    /** "Accept all N" → apply every visible suggestion, right-to-left,
     *  single Undo. The orchestrator owns the apply + the toast. */
    onAcceptAll: () => void
    /** "Accept N high-confidence only" — the panel shows this button
     *  ONLY when 0 < high < total (the visibility is part of the model,
     *  not the caller). The orchestrator owns the apply + the toast. */
    onAcceptHighConf: () => void
    /** "Accept all <category>" per-group — fired with the group category. */
    onAcceptCategory: (cat: Category) => void
    /** Click a row → focus that suggestion in the field (the orchestrator
     *  resolves the row's item id to a card / popover). */
    onAcceptItem: (item: RenderableItem) => void
    /** "Rephrase message" — optional. Omit to hide the button. */
    onRephrase?: () => void
    /** Goals pill click → open the goals popover. The orchestrator
     *  positions + mounts `showGoals` anchored to the pill. */
    onOpenGoals: () => void
    /** Stats tab click — W2-4 wires the Stats view. The button is
     *  always rendered as a tab; clicking it fires this callback. */
    onOpenStats: () => void
    /** Review tab click — fires when the user switches BACK from Stats to
     *  Review. The orchestrator destroys the Stats view and re-renders the
     *  review body content into the body container. */
    onOpenReview: () => void
    /** Recheck button (head) — forces a fresh check of the field. */
    onRecheck: () => void
    /** Footer "Disable on this site" — flips the runtime-wide pause. */
    onDisableSite: () => void
    /** W3-3b: when true, the panel renders the paused empty-state
     *  (a centered message + a "Turn on for this site" button) INSTEAD
     *  of the score→list body. Head + tabs + footer stay mounted so the
     *  user can still close / re-enable without a second mount. The
     *  "Turn on for this site" button wires through `onDisableSite` —
     *  pausing is symmetric, so re-enabling uses the same flip callback
     *  the footer uses to disable. */
    disabled?: boolean
    /** "×" close in the head — the orchestrator tears down the panel. */
    onClose: () => void
}

export interface PanelHandle {
    /** Tear down the panel. Safe to call multiple times; subsequent calls
     *  are no-ops. */
    destroy: () => void
    /** True while the panel is mounted in the shadow root. */
    isOpen: () => boolean
    /** Get the body container — the slot that holds the review content
     *  (banner + score + insights + actions + list). The W2-4 Stats view
     *  mounts INTO this slot when the Stats tab is clicked: the orchestrator
     *  calls `mountStatsView(panel.getBodyContainer(), deps)`. Returns
     *  null after destroy(). */
    getBodyContainer: () => HTMLElement | null
    /** Which tab is currently active. Used by the orchestrator to guard
     *  the on-check refresh: restoreReviewBody is a no-op when Stats is
     *  active (so a check completing while the user is on Stats doesn't
     *  clobber the Stats view). */
    getActiveTab: () => 'review' | 'stats'
    /** Restore the Review body IN PLACE (no panel teardown/rebuild).
     *  Clears the body container and re-renders the review content with
     *  fresh items/text/goals/phase. Used by onOpenReview to switch from
     *  Stats back to Review without a flash. Returns false if the panel
     *  is already destroyed OR if the Stats tab is currently active
     *  (guard: a check completing while Stats is shown must not clobber
     *  the Stats view). */
    restoreReviewBody: (
        items: readonly RenderableItem[],
        text: string,
        goals: Goals,
        phase: Phase,
        hasRephrase: boolean,
    ) => boolean
}

const VIEWPORT_GUTTER = 8
const PANEL_WIDTH = 344
const PANEL_HEIGHT_FALLBACK = 480

/**
 * Mount the review panel in the supplied shadow root, anchored to the
 * orb's rect. Replaces any prior review panel (only one at a time per
 * root — new showPanel() dismisses the prior via `destroyExisting`).
 * Returns a handle whose `destroy()` removes the panel and its listeners.
 *
 * The panel is a SURFACE — caller-measured anchor, no self-measure, no
 * opacity transition. The entrance is transform-only (scale-in from
 * `transform-origin: 100% 100%` = the orb's bottom-right corner). Default
 * `opacity: 1` so a non-animating context (reduced-motion / first paint
 * without an animation frame) never strands the panel invisible.
 */
export function showPanel(root: ShadowRoot, options: PanelOptions): PanelHandle {
    destroyExisting(root)
    const doc = root.ownerDocument
    const view = doc.defaultView ?? window

    const aside = doc.createElement('aside')
    aside.className = 'gf-panel-aside'
    aside.setAttribute('role', 'dialog')
    aside.setAttribute('aria-label', 'GrammarForge review')

    // Build the model ONCE per show (the caller's onAccept* are wired to
    // fresh closures; an update() could be added later for live phase /
    // goals changes, but the W2b scope freezes the model at open time).
    const model = buildPanelModel({
        items: options.items,
        text: options.text,
        goals: options.goals,
        phase: options.phase,
    })
    const goalsLabel = formatFormality(options.goals.formality)
    // W3-3b: when disabled (site paused), the body renders the paused
    // empty-state instead of the score→list review. The head + tabs +
    // footer stay mounted (so the user can close / re-enable without
    // a second mount); only the body changes. Both render paths share
    // the chrome via `renderChrome()`.
    const body = options.disabled
        ? renderChrome(aside, goalsLabel, (bodyEl) => renderDisabledBodyContent(bodyEl))
        : renderChrome(aside, goalsLabel, (bodyEl) =>
              renderReviewBodyContent(
                  bodyEl,
                  model,
                  options.onRephrase !== undefined,
                  goalsLabel,
              ),
          )

    root.appendChild(aside)
    positionPanel(aside, options.anchorRect, view)

    // Single delegated click handler — data-action is the public contract.
    // Adding more buttons later means registering a new `action` branch
    // here (no per-button listeners to leak).
    const onClick = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null
        const btn = target?.closest<HTMLElement>('[data-action]')
        if (!btn) return
        if (btn instanceof HTMLButtonElement && btn.disabled) return
        event.preventDefault()
        event.stopPropagation()
        const action = btn.dataset.action
        if (action === 'close') {
            options.onClose()
            return
        }
        if (action === 'recheck') {
            options.onRecheck()
            return
        }
        if (action === 'open-goals') {
            options.onOpenGoals()
            return
        }
        if (action === 'open-stats') {
            options.onOpenStats()
            return
        }
        if (action === 'open-review') {
            options.onOpenReview()
            return
        }
        if (action === 'accept-all') {
            options.onAcceptAll()
            return
        }
        if (action === 'accept-high') {
            options.onAcceptHighConf()
            return
        }
        if (action === 'rephrase') {
            options.onRephrase?.()
            return
        }
        if (action === 'disable-site') {
            options.onDisableSite()
            return
        }
        if (action === 'accept-category') {
            const cat = btn.dataset.category
            if (cat) options.onAcceptCategory(cat as Category)
            return
        }
        if (action === 'accept-item') {
            const id = btn.dataset.itemId
            if (id) {
                const item = findItemById(options.items, id)
                if (item) options.onAcceptItem(item)
            }
            return
        }
    }
    // mousedown preventDefault on action buttons so the field doesn't
    // lose focus while the user is interacting with the panel.
    const onMouseDown = (event: MouseEvent): void => {
        const target = event.target as HTMLElement | null
        if (target?.closest('[data-action]')) event.preventDefault()
    }
    aside.addEventListener('click', onClick)
    aside.addEventListener('mousedown', onMouseDown)

    // Outside-click (light-dismiss) via the unified dismiss helper.
    // Uses window capture so host-page stopPropagation can't block it.
    // Child popovers (Goals, synonyms, correction card) are siblings in
    // the shadow root — exclude them so clicking inside them doesn't
    // close the panel.
    const outsideDismiss: OutsideDismissHandle = installOutsideDismiss(
        view,
        (el) => {
            if (aside.contains(el) || el === aside) return true
            // Sibling popovers in the shadow root — keep panel open.
            if (el.classList.contains('gf-goals-pop')) return true
            if (el.classList.contains('gf-syn')) return true
            if (el.classList.contains('gf-card')) return true
            return false
        },
        () => options.onClose(),
        'panel',
    )

    // `bodyRef` mirrors the body element, but is nulled by destroy() so
    // `getBodyContainer()` returns null after teardown (the detached
    // .gf-panel__body element would otherwise be returned and a caller
    // that trusts the JSDoc would mount into a dead container). The
    // open-state behavior is unchanged: returns the live .gf-panel__body
    // element while the panel is mounted.
    let bodyRef: HTMLElement | null = body
    // Track the active tab so restoreReviewBody can guard against
    // clobbering the Stats view when a check completes while Stats is shown.
    let activeTab: 'review' | 'stats' = 'review'
    // Wire the tab-state updater back into renderChrome's setActiveTab so
    // clicking a tab updates both the DOM indicator AND this closure's state.
    ;(aside as HTMLElement & { _gfSetActiveTabState: (t: 'review' | 'stats') => void })._gfSetActiveTabState =
        (tab: 'review' | 'stats') => { activeTab = tab }

    return {
        destroy: () => {
            outsideDismiss.remove()
            aside.removeEventListener('click', onClick)
            aside.removeEventListener('mousedown', onMouseDown)
            if (aside.isConnected) aside.remove()
            bodyRef = null
        },
        isOpen: () => aside.isConnected,
        getBodyContainer: () => bodyRef,
        getActiveTab: () => activeTab,
        restoreReviewBody: (
            items: readonly RenderableItem[],
            text: string,
            goals: Goals,
            phase: Phase,
            hasRephrase: boolean,
        ): boolean => {
            if (!bodyRef || !bodyRef.isConnected) return false
            // Guard: when Stats is active, a check completing must NOT
            // clobber the Stats view. Return false so the caller knows
            // the refresh was skipped (it will fire again on next check
            // after the user switches back to Review).
            if (activeTab === 'stats') return false
            // Build the new review content OFF-DOM in a DocumentFragment,
            // then swap it in with ONE atomic replaceChildren() call.
            // This avoids the intermediate empty-body flash that occurs
            // when clearing first and rebuilding second.
            const freshModel = buildPanelModel({ items, text, goals, phase })
            const frag = doc.createDocumentFragment()
            // Render into a temporary container, then move children to frag.
            const tmp = doc.createElement('div')
            renderReviewBodyContent(tmp, freshModel, hasRephrase, formatFormality(goals.formality))
            while (tmp.firstChild) frag.appendChild(tmp.firstChild)
            // Atomic swap: no intermediate empty state.
            bodyRef.replaceChildren(frag)
            return true
        },
    }
}

function destroyExisting(root: ShadowRoot): void {
    root.querySelectorAll('.gf-panel-aside').forEach((el) => el.remove())
}

function findItemById(
    items: readonly RenderableItem[],
    id: string,
): RenderableItem | null {
    for (const it of items) {
        const itemId = it.id !== undefined ? String(it.id) : `${it.cuStart}:${it.cuEnd}:${it.category}`
        if (itemId === id) return it
    }
    return null
}

function formatFormality(formality: Goals['formality']): string {
    if (formality === 'formal') return 'Formal'
    if (formality === 'informal') return 'Informal'
    return 'Neutral'
}

function positionPanel(panel: HTMLElement, anchor: DOMRect, view: Window): void {
    const vw = view.innerWidth
    const vh = view.innerHeight
    const width = panel.offsetWidth || PANEL_WIDTH
    const height = panel.offsetHeight || PANEL_HEIGHT_FALLBACK
    // Right-align the panel to the orb's right edge so it expands from
    // the bottom-right corner (transform-origin: 100% 100%). Sit just
    // above the orb with a small gap; flip below if no room above.
    let left = anchor.right - width
    if (left < VIEWPORT_GUTTER) left = VIEWPORT_GUTTER
    if (left + width > vw - VIEWPORT_GUTTER) left = vw - width - VIEWPORT_GUTTER
    let top = anchor.top - height - 8
    if (top < VIEWPORT_GUTTER) top = anchor.bottom + 8
    if (top + height > vh - VIEWPORT_GUTTER) top = vh - height - VIEWPORT_GUTTER
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
}

/** Render the shared panel chrome (head + tabs + body slot + footer) and
 *  call `renderBody` to fill the body slot. The body slot is the same
 *  element `getBodyContainer()` returns (so the W2-4 Stats view can
 *  mount into it later by replacing children). Head + tabs + footer are
 *  outside the slot, so the Stats view renders without a second copy
 *  of the chrome. Returns the body element so callers can append
 *  additional children. The `goalsLabel` argument drives the head's
 *  Goals pill text (e.g. "Neutral" / "Informal" / "Formal"). */
function renderChrome(
    aside: HTMLElement,
    goalsLabel: string,
    renderBody: (bodyEl: HTMLElement) => void,
): HTMLElement {
    // Head
    const head = el(aside, 'div', 'gf-panel__head')
    const logo = el(head, 'span', 'gf-panel__logo')
    logo.appendChild(svgInline(LOGO_PATH))
    el(head, 'span', 'gf-panel__title').textContent = 'GrammarForge'
    el(head, 'span', 'gf-panel__spacer')
    const goalsPill = el(head, 'button', 'gf-goals-pill') as HTMLButtonElement
    goalsPill.type = 'button'
    goalsPill.setAttribute('data-action', 'open-goals')
    goalsPill.setAttribute('aria-haspopup', 'dialog')
    goalsPill.appendChild(el(goalsPill, 'span', 'gf-goals-pill__dot'))
    goalsPill.appendChild(document.createTextNode(`\u00A0${goalsLabel}`))
    const recheck = iconButton(head, 'recheck', 'Re-check')
    recheck.setAttribute('data-action', 'recheck')
    const close = iconButton(head, 'close', 'Close')
    close.setAttribute('data-action', 'close')

    // Tabs (Review / Stats)
    const tabs = el(aside, 'div', 'gf-panel__tabs')
    tabs.setAttribute('role', 'tablist')
    const reviewTab = el(tabs, 'button', 'gf-tab is-active') as HTMLButtonElement
    reviewTab.type = 'button'
    reviewTab.setAttribute('role', 'tab')
    reviewTab.setAttribute('aria-selected', 'true')
    reviewTab.setAttribute('data-action', 'open-review')
    reviewTab.textContent = 'Review'
    const statsTab = el(tabs, 'button', 'gf-tab') as HTMLButtonElement
    statsTab.type = 'button'
    statsTab.setAttribute('role', 'tab')
    statsTab.setAttribute('aria-selected', 'false')
    statsTab.setAttribute('data-action', 'open-stats')
    statsTab.textContent = 'Stats'

    // Expose a tab-sync helper on the aside element so the orchestrator
    // can toggle the active tab indicator WITHOUT rebuilding the panel.
    // Called synchronously before mounting the Stats view or restoring
    // the Review body — so the indicator is always in sync with content.
    // Also updates the handle's activeTab state so restoreReviewBody can
    // guard against clobbering the Stats view on a check-refresh.
    // The activeTabRef is a shared mutable box between renderChrome and
    // the handle's restoreReviewBody closure.
    ;(aside as HTMLElement & { setActiveTab: (tab: 'review' | 'stats') => void }).setActiveTab =
        (tab: 'review' | 'stats') => {
            const isReview = tab === 'review'
            reviewTab.classList.toggle('is-active', isReview)
            reviewTab.setAttribute('aria-selected', String(isReview))
            statsTab.classList.toggle('is-active', !isReview)
            statsTab.setAttribute('aria-selected', String(!isReview))
            // Update the handle's activeTab via the shared ref injected below.
            if ((aside as HTMLElement & { _gfSetActiveTabState?: (t: 'review' | 'stats') => void })._gfSetActiveTabState) {
                (aside as HTMLElement & { _gfSetActiveTabState: (t: 'review' | 'stats') => void })._gfSetActiveTabState(tab)
            }
        }

    // Body slot
    const body = el(aside, 'div', 'gf-panel__body')
    renderBody(body)

    // Footer
    const footer = el(aside, 'div', 'gf-panel__footer')
    el(footer, 'span', 'gf-panel__learns').textContent = '\u2728 Learns your style'
    el(footer, 'span', 'gf-panel__spacer')
    const disable = el(footer, 'button', 'gf-panel__soft') as HTMLButtonElement
    disable.type = 'button'
    disable.setAttribute('data-action', 'disable-site')
    disable.textContent = 'Disable on this site'

    return body
}

/** Fill a body slot with the paused empty-state (W3-3b). Centered
 *  message + a "Turn on for this site" button (which re-uses the
 *  `data-action="disable-site"` branch — pausing is symmetric, so the
 *  same callback that disables the site re-enables it). The chrome
 *  (head + tabs + footer) is rendered by `renderChrome`; this function
 *  only populates the body slot. */
function renderDisabledBodyContent(body: HTMLElement): void {
    const wrap = el(body, 'div', 'gf-panel__paused')
    const icon = el(wrap, 'span', 'gf-panel__paused-icon')
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = '\u23F8'
    const title = el(wrap, 'p', 'gf-panel__paused-title')
    title.textContent = 'GrammarForge is paused on this site'
    const sub = el(wrap, 'p', 'gf-panel__paused-sub')
    sub.textContent =
        'Suggestions and on-page checks are off. Re-enable to keep writing with the same corrections as before.'
    const btn = el(wrap, 'button', 'gf-panel__primary') as HTMLButtonElement
    btn.type = 'button'
    btn.setAttribute('data-action', 'disable-site')
    btn.textContent = 'Turn on for this site'
    // The click is dispatched by the panel's delegated `onClick` (see
    // showPanel) via `data-action="disable-site"` → options.onDisableSite
    // — no per-button listener is wired here.
}

/** Fill a body slot with the full review content (banner + score +
 *  insights + actions + grouped list + muted note). */
function renderReviewBodyContent(
    body: HTMLElement,
    m: PanelModel,
    hasRephrase: boolean,
    _goalsLabel: string,
): void {
    // Streaming banner
    if (m.showStreamingBanner) {
        const banner = el(body, 'div', 'gf-banner')
        banner.setAttribute('aria-live', 'polite')
        const spinner = el(banner, 'span', 'gf-spinner')
        spinner.setAttribute('aria-hidden', 'true')
        const text = el(banner, 'span', 'gf-banner__text')
        text.textContent = 'Fast results in \u00B7 AI refining\u2026'
    }

    // Score block: ring + band + count
    const score = el(body, 'div', 'gf-panel__score')
    score.appendChild(buildRingSvg(m))
    const right = el(score, 'div')
    const band = el(right, 'div', 'gf-band')
    band.textContent = bandLabel(m.band)
    band.style.color = m.ringColor
    const sub = el(right, 'div', 'gf-panel__sub')
    sub.textContent = m.suggestionCount === 0
        ? 'No issues remaining \u2014 ready to send.'
        : `${String(m.suggestionCount)} suggestion${m.suggestionCount === 1 ? '' : 's'} as you type`

    // Insights
    const insights = el(body, 'div', 'gf-panel__insights')
    addStat(insights, 'Tone', null, toneHTML())
    addStat(insights, 'Readability', String(m.readabilityLabel), null)
    addStat(insights, 'Words', String(m.words), null)
    addStat(insights, 'Read time', `${String(m.readSecs)}s`, null)

    // Bulk actions
    if (m.suggestionCount > 0) {
        const actions = el(body, 'div', 'gf-panel__actions')
        const acceptAll = el(actions, 'button', 'gf-panel__primary') as HTMLButtonElement
        acceptAll.type = 'button'
        acceptAll.setAttribute('data-action', 'accept-all')
        acceptAll.textContent = `Accept all ${String(m.suggestionCount)} suggestion${m.suggestionCount === 1 ? '' : 's'}`
        if (m.showHighConfButton) {
            const acceptHigh = el(actions, 'button', 'gf-panel__soft') as HTMLButtonElement
            acceptHigh.type = 'button'
            acceptHigh.setAttribute('data-action', 'accept-high')
            acceptHigh.textContent = `\u2713 Accept ${String(m.highConfCount)} high-confidence only`
        }
        if (hasRephrase) {
            const rephrase = el(actions, 'button', 'gf-panel__soft') as HTMLButtonElement
            rephrase.type = 'button'
            rephrase.setAttribute('data-action', 'rephrase')
            rephrase.textContent = '\u2728 Rephrase message'
        }
    }

    // Grouped list (scrollable)
    if (m.groups.length > 0 || m.showMutedNote) {
        const list = el(body, 'div', 'gf-panel__list')
        for (const group of m.groups) {
            const g = el(list, 'div', 'gf-group')
            const head = el(g, 'div', 'gf-group__head')
            const dot = el(head, 'span', 'gf-group__dot')
            dot.style.background = group.dot
            const label = el(head, 'span')
            label.textContent = group.label
            const count = el(head, 'span', 'gf-group__count')
            count.textContent = String(group.items.length)
            el(head, 'span', 'gf-panel__spacer')
            const acceptCat = el(head, 'button', 'gf-textbtn') as HTMLButtonElement
            acceptCat.type = 'button'
            acceptCat.setAttribute('data-action', 'accept-category')
            acceptCat.setAttribute('data-category', group.category)
            acceptCat.textContent = 'Accept all'
            for (const gItem of group.items) {
                const row = el(g, 'button', 'gf-row-item') as HTMLButtonElement
                row.type = 'button'
                row.setAttribute('data-action', 'accept-item')
                row.setAttribute(
                    'data-item-id',
                    gItem.item.id !== undefined
                        ? String(gItem.item.id)
                        : `${String(gItem.item.cuStart)}:${String(gItem.item.cuEnd)}:${gItem.item.category}`,
                )
                const diff = el(row, 'span', 'gf-row-item__diff')
                diff.innerHTML = diffInnerHTML(
                    gItem.item.diffOriginal,
                    gItem.item.diffCorrected,
                    gItem.item.diffIsDeletion,
                )
                const chip = el(row, 'span', 'gf-chip-source')
                if (gItem.item.model === 'llm') {
                    chip.classList.add('gf-chip-source--ai')
                    chip.textContent = '\u2728 AI'
                } else {
                    chip.appendChild(document.createTextNode(gItem.chipLabel))
                    const hint = el(chip, 'span', 'gf-chip-source__hint')
                    hint.textContent = ' \u00B7 instant'
                }
            }
        }
        if (m.showMutedNote) {
            const note = el(list, 'div', 'gf-hidden-note')
            const noteDot = el(note, 'span', 'gf-group__dot')
            noteDot.style.background = '#8b5cf6'
            note.appendChild(
                document.createTextNode(
                    `${String(m.mutedStyleCount)} style suggestion${m.mutedStyleCount === 1 ? '' : 's'} muted by your goals`,
                ),
            )
            el(note, 'span', 'gf-panel__spacer')
            const goalsBtn = el(note, 'button', 'gf-textbtn') as HTMLButtonElement
            goalsBtn.type = 'button'
            goalsBtn.setAttribute('data-action', 'open-goals')
            goalsBtn.textContent = 'Goals'
        }
    }
}

function el(parent: Node, tag: string, className?: string): HTMLElement {
    const node = document.createElement(tag)
    if (className) node.className = className
    parent.appendChild(node)
    return node
}

function iconButton(parent: HTMLElement, kind: 'recheck' | 'close', ariaLabel: string): HTMLButtonElement {
    const btn = el(parent, 'button', 'gf-panel__iconbtn') as HTMLButtonElement
    btn.type = 'button'
    btn.setAttribute('aria-label', ariaLabel)
    if (kind === 'close') btn.textContent = '\u00D7'
    else btn.appendChild(svgInline(RECHECK_PATH))
    return btn
}

const LOGO_PATH =
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'
const RECHECK_PATH =
    'M20 11 A8 8 0 1 0 18.4 16 M20 4 L20 11 L13 11'

function svgInline(pathData: string): SVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '13')
    svg.setAttribute('height', '13')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2.2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', pathData)
    svg.appendChild(path)
    return svg
}

function buildRingSvg(m: PanelModel): SVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'gf-panel__ring')
    svg.setAttribute('viewBox', '0 0 60 60')
    svg.setAttribute('width', '60')
    svg.setAttribute('height', '60')
    svg.setAttribute('aria-hidden', 'true')
    const track = document.createElementNS(SVG_NS, 'circle')
    track.setAttribute('class', 'gf-panel__ring-track')
    track.setAttribute('cx', '30')
    track.setAttribute('cy', '30')
    track.setAttribute('r', String(m.ringRadius))
    svg.appendChild(track)
    const arc = document.createElementNS(SVG_NS, 'circle')
    arc.setAttribute('cx', '30')
    arc.setAttribute('cy', '30')
    arc.setAttribute('r', String(m.ringRadius))
    arc.setAttribute('fill', 'none')
    arc.setAttribute('stroke-width', '5')
    arc.setAttribute('stroke-linecap', 'round')
    arc.setAttribute('stroke-dasharray', m.ringDasharray.toFixed(1))
    arc.setAttribute('stroke-dashoffset', m.ringOffset.toFixed(2))
    arc.setAttribute('stroke', m.ringColor)
    arc.setAttribute('transform', 'rotate(-90 30 30)')
    svg.appendChild(arc)
    return svg
}

function bandLabel(band: PanelModel['band']): string {
    if (band === 'excellent') return 'Excellent'
    if (band === 'good') return 'Good'
    if (band === 'fair') return 'Fair'
    return 'Needs work'
}

function addStat(
    parent: HTMLElement,
    label: string,
    textBody: string | null,
    elementBody: HTMLElement | null,
): void {
    const cell = el(parent, 'div', 'gf-stat')
    el(cell, 'div', 'gf-stat__label').textContent = label
    const body = el(cell, 'div', 'gf-stat__body')
    if (elementBody) {
        body.appendChild(elementBody)
    } else if (textBody) {
        body.textContent = textBody
    }
}

function toneHTML(): HTMLElement {
    // Static decorative tags (NOT computed from /tone) — the reference DC
    // hardcodes these. The orchestrator is free to swap them later.
    const wrap = document.createElement('span')
    const c1 = document.createElement('span')
    const dot1 = document.createElement('span')
    dot1.className = 'gf-stat__tone-dot'
    dot1.style.background = '#16a34a'
    c1.appendChild(dot1)
    c1.appendChild(document.createTextNode('Confident'))
    const sep = document.createTextNode('  ')
    const c2 = document.createElement('span')
    const dot2 = document.createElement('span')
    dot2.className = 'gf-stat__tone-dot'
    dot2.style.background = '#2563eb'
    c2.appendChild(dot2)
    c2.appendChild(document.createTextNode('Warm'))
    wrap.append(c1, sep, c2)
    return wrap
}
