// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { showPanel, type PanelOptions } from '@/overlay/panel'
import { BAND_COLOR } from '@/lib/view-model'
import type { RenderableItem } from '@/lib/pipeline'
import type { Category, Goals } from '@/api/types'

function mkRoot(): ShadowRoot {
    const host = document.createElement('div')
    document.body.appendChild(host)
    return host.attachShadow({ mode: 'open' })
}

const ANCHOR = new DOMRect(100, 100, 400, 200)

const item = (overrides: Partial<RenderableItem> = {}): RenderableItem => ({
    id: 1,
    cuStart: 0,
    cuEnd: 0,
    hlStart: 0,
    hlEnd: 0,
    category: 'spelling',
    message: '',
    replacements: ['the'],
    original: 'teh',
    diffOriginal: 'teh',
    diffCorrected: 'the',
    diffIsDeletion: false,
    byteSpan: { start: 0, end: 3 },
    model: 'harper',
    confidence: 0.95,
    status: 'open',
    ...overrides,
})

const neutralGoals: Goals = { audience: 'general', formality: 'neutral' }

function mkOptions(overrides: Partial<PanelOptions> = {}): PanelOptions {
    return {
        anchorRect: ANCHOR,
        items: [item()],
        text: 'I think we should of merged the fix.',
        goals: neutralGoals,
        phase: 'done',
        onAcceptAll: vi.fn<() => void>(),
        onAcceptHighConf: vi.fn<() => void>(),
        onAcceptCategory: vi.fn<(c: Category) => void>(),
        onAcceptItem: vi.fn<(i: RenderableItem) => void>(),
        onOpenGoals: vi.fn<() => void>(),
        onOpenStats: vi.fn<() => void>(),
        onOpenReview: vi.fn<() => void>(),
        onRecheck: vi.fn<() => void>(),
        onDisableSite: vi.fn<() => void>(),
        onClose: vi.fn<() => void>(),
        ...overrides,
    }
}

describe('showPanel (W2b review panel)', () => {
    it('mounts a .gf-panel-aside in the shadow root (NOT the W1 .gf-pill-panel)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        expect(root.querySelector('.gf-panel-aside')).not.toBeNull()
        expect(root.querySelector('.gf-pill-panel')).toBeNull()
    })

    it('renders the score RING with r=24.5 + dasharray=153.9 (reference DC geometry)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const arc = root.querySelector('.gf-panel__ring circle[stroke-dasharray]') as SVGGeometryElement
        expect(arc).not.toBeNull()
        expect(arc.getAttribute('cx')).toBe('30')
        expect(arc.getAttribute('cy')).toBe('30')
        expect(arc.getAttribute('r')).toBe('24.5')
        expect(arc.getAttribute('stroke-dasharray')).toBe('153.9')
    })

    it('ring color matches BAND_COLOR[band] (consumed from view-model, not re-derived)', () => {
        // 1 spelling (5) → score 95 → excellent → #16a34a
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item({ category: 'spelling' })] }))
        const arc = root.querySelector('.gf-panel__ring circle[stroke-dasharray]') as SVGGeometryElement
        expect(arc.getAttribute('stroke')).toBe(BAND_COLOR.excellent)
    })

    it('ring dashoffset equals arcOffset(score) (consumed from view-model)', () => {
        // 5 spelling items → score 75 → ringOffset = 153.9 * 0.25 = 38.475
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: Array.from({ length: 5 }, (_, i) => item({ id: i + 1, category: 'spelling' })),
            }),
        )
        const arc = root.querySelector('.gf-panel__ring circle[stroke-dasharray]') as SVGGeometryElement
        expect(parseFloat(arc.getAttribute('stroke-dashoffset') ?? '')).toBeCloseTo(38.475)
    })

    it('head contains the title, Goals pill, recheck, and close buttons', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const head = root.querySelector('.gf-panel__head') as HTMLElement
        expect(head).not.toBeNull()
        expect(head.querySelector('.gf-panel__title')?.textContent).toBe('GrammarForge')
        expect(head.querySelector('.gf-goals-pill')).not.toBeNull()
        expect(head.querySelector('[data-action="recheck"]')).not.toBeNull()
        expect(head.querySelector('[data-action="close"]')).not.toBeNull()
    })

    it('the goals pill label reflects goals.formality', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ goals: { audience: 'general', formality: 'formal' } }))
        const pill = root.querySelector('.gf-goals-pill') as HTMLElement
        expect(pill.textContent).toContain('Formal')
    })

    it('tabs row renders Review (active) + Stats', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const tabs = root.querySelector('.gf-panel__tabs') as HTMLElement
        const review = tabs.querySelector('.gf-tab.is-active') as HTMLElement
        const stats = tabs.querySelector('[data-action="open-stats"]') as HTMLElement
        expect(review.textContent).toBe('Review')
        expect(stats.textContent).toBe('Stats')
    })

    it('shows the streaming banner ONLY while phase === "fast"', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ phase: 'fast' }))
        expect(root.querySelector('.gf-banner')).not.toBeNull()
        expect(root.querySelector('.gf-banner')?.textContent).toContain('Fast results in')
        const handle = root.querySelector('.gf-panel-aside') as HTMLElement
        handle.remove()
        showPanel(root, mkOptions({ phase: 'done' }))
        expect(root.querySelector('.gf-banner')).toBeNull()
    })

    it('insights row has 4 stat cells (Tone / Readability / Words / Read time)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const insights = root.querySelector('.gf-panel__insights') as HTMLElement
        const cells = insights.querySelectorAll('.gf-stat')
        expect(cells).toHaveLength(4)
        const labels = Array.from(cells).map((c) => c.querySelector('.gf-stat__label')?.textContent)
        expect(labels).toEqual(['Tone', 'Readability', 'Words', 'Read time'])
    })

    it('the tone cell renders the static decorative "Confident" + "Warm" tags', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const tone = root.querySelector('.gf-stat .gf-stat__body') as HTMLElement
        expect(tone.textContent).toContain('Confident')
        expect(tone.textContent).toContain('Warm')
    })

    it('bulk actions include "Accept all N" (primary) when items > 0', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item(), item({ id: 2 }), item({ id: 3 })] }))
        const acceptAll = root.querySelector('[data-action="accept-all"]') as HTMLElement
        expect(acceptAll).not.toBeNull()
        expect(acceptAll.textContent).toContain('Accept all 3')
    })

    it('high-confidence button is rendered when 0 < highConf < total', () => {
        // 2 high-conf + 1 low-conf → button should show
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: [
                    item({ id: 1, confidence: 0.95 }),
                    item({ id: 2, confidence: 0.95 }),
                    item({ id: 3, confidence: 0.5 }),
                ],
            }),
        )
        const btn = root.querySelector('[data-action="accept-high"]') as HTMLElement
        expect(btn).not.toBeNull()
        expect(btn.textContent).toContain('2 high-confidence')
    })

    it('high-confidence button is HIDDEN when highConf === total (all are high; bulk covers it)', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: [
                    item({ id: 1, confidence: 0.95 }),
                    item({ id: 2, confidence: 0.95 }),
                ],
            }),
        )
        expect(root.querySelector('[data-action="accept-high"]')).toBeNull()
    })

    it('high-confidence button is HIDDEN when highConf === 0 (no point)', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: [item({ id: 1, confidence: 0.5 }), item({ id: 2, confidence: 0.3 })],
            }),
        )
        expect(root.querySelector('[data-action="accept-high"]')).toBeNull()
    })

    it('rephrase button is rendered ONLY when onRephrase is supplied', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ onRephrase: vi.fn<() => void>() }))
        expect(root.querySelector('[data-action="rephrase"]')).not.toBeNull()
        const aside = root.querySelector('.gf-panel-aside') as HTMLElement
        aside.remove()
        showPanel(root, mkOptions({ onRephrase: undefined }))
        expect(root.querySelector('[data-action="rephrase"]')).toBeNull()
    })

    it('grouped list groups visible items by category, in canonical order', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: [
                    item({ id: 1, category: 'style' }),
                    item({ id: 2, category: 'spelling' }),
                    item({ id: 3, category: 'grammar' }),
                ],
            }),
        )
        const groups = root.querySelectorAll('.gf-group')
        expect(groups).toHaveLength(3)
        // First span inside each head is the colored dot (no text); the
        // second is the category label.
        const textLabels = Array.from(groups).map(
            (g) => g.querySelectorAll('.gf-group__head span')[1]?.textContent,
        )
        expect(textLabels).toEqual(['Spelling', 'Grammar', 'Style'])
    })

    it('each group exposes a per-category "Accept all" chip', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item({ category: 'spelling' })] }))
        const acceptCat = root.querySelector('[data-action="accept-category"]') as HTMLElement
        expect(acceptCat).not.toBeNull()
        expect(acceptCat.getAttribute('data-category')).toBe('spelling')
    })

    it('per-row buttons expose the item id (for the orchestrator to focus that card)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item({ id: 42, category: 'spelling' })] }))
        const row = root.querySelector('.gf-row-item') as HTMLElement
        expect(row.getAttribute('data-item-id')).toBe('42')
    })

    it('per-row buttons render the red->green diff via diffInnerHTML', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                items: [
                    item({
                        id: 1,
                        diffOriginal: 'teh',
                        diffCorrected: 'the',
                        diffIsDeletion: false,
                    }),
                ],
            }),
        )
        const row = root.querySelector('.gf-row-item') as HTMLElement
        expect(row.querySelector('.gf-diff__old')?.textContent).toBe('teh')
        expect(row.querySelector('.gf-diff__new')?.textContent).toBe('the')
    })

    it('LLM items get the "✨ AI" source chip (no "· instant" suffix)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item({ id: 1, model: 'llm' })] }))
        const chip = root.querySelector('.gf-chip-source--ai') as HTMLElement
        expect(chip).not.toBeNull()
        expect(chip.textContent).toContain('AI')
    })

    it('Harper / GECToR rows get the "· instant" suffix chip', () => {
        const root = mkRoot()
        showPanel(root, mkOptions({ items: [item({ id: 1, model: 'harper' })] }))
        const chip = root.querySelector('.gf-chip-source') as HTMLElement
        expect(chip.textContent).toContain('Harper')
        expect(chip.querySelector('.gf-chip-source__hint')?.textContent).toContain('instant')
    })

    it('shows the dashed "N style suggestions muted by your goals" note when informal + style items', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                goals: { audience: 'general', formality: 'informal' },
                items: [item({ id: 1, category: 'style' }), item({ id: 2, category: 'style' })],
            }),
        )
        const note = root.querySelector('.gf-hidden-note') as HTMLElement
        expect(note).not.toBeNull()
        expect(note.textContent).toContain('2 style suggestions muted by your goals')
    })

    it('the muted note has a Goals shortcut button', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                goals: { audience: 'general', formality: 'informal' },
                items: [item({ category: 'style' })],
            }),
        )
        const note = root.querySelector('.gf-hidden-note') as HTMLElement
        const btn = note.querySelector('[data-action="open-goals"]') as HTMLElement
        expect(btn.textContent).toBe('Goals')
    })

    it('NO muted note when goals.formality is neutral or formal', () => {
        const root = mkRoot()
        showPanel(
            root,
            mkOptions({
                goals: { audience: 'general', formality: 'neutral' },
                items: [item({ category: 'style' })],
            }),
        )
        expect(root.querySelector('.gf-hidden-note')).toBeNull()
    })

    it('footer renders the "Disable on this site" action', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        const footer = root.querySelector('.gf-panel__footer') as HTMLElement
        const disable = footer.querySelector('[data-action="disable-site"]') as HTMLElement
        expect(disable).not.toBeNull()
        expect(disable.textContent).toContain('Disable on this site')
    })

    it('clicking "×" close fires onClose', () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showPanel(root, mkOptions({ onClose }))
        const close = root.querySelector('[data-action="close"]') as HTMLElement
        close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('clicking recheck fires onRecheck', () => {
        const root = mkRoot()
        const onRecheck = vi.fn<() => void>()
        showPanel(root, mkOptions({ onRecheck }))
        const recheck = root.querySelector('[data-action="recheck"]') as HTMLElement
        recheck.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onRecheck).toHaveBeenCalledOnce()
    })

    it('clicking "Accept all N" fires onAcceptAll', () => {
        const root = mkRoot()
        const onAcceptAll = vi.fn<() => void>()
        showPanel(root, mkOptions({ onAcceptAll }))
        const btn = root.querySelector('[data-action="accept-all"]') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onAcceptAll).toHaveBeenCalledOnce()
    })

    it('clicking "Accept N high-confidence" fires onAcceptHighConf', () => {
        const root = mkRoot()
        const onAcceptHighConf = vi.fn<() => void>()
        showPanel(
            root,
            mkOptions({
                onAcceptHighConf,
                items: [
                    item({ id: 1, confidence: 0.95 }),
                    item({ id: 2, confidence: 0.5 }),
                ],
            }),
        )
        const btn = root.querySelector('[data-action="accept-high"]') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onAcceptHighConf).toHaveBeenCalledOnce()
    })

    it('clicking a per-category "Accept all" fires onAcceptCategory(category)', () => {
        const root = mkRoot()
        const onAcceptCategory = vi.fn<(c: Category) => void>()
        showPanel(
            root,
            mkOptions({
                onAcceptCategory,
                items: [item({ category: 'spelling' })],
            }),
        )
        const btn = root.querySelector('[data-action="accept-category"]') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onAcceptCategory).toHaveBeenCalledWith('spelling')
    })

    it('clicking a row fires onAcceptItem with the matching item', () => {
        const root = mkRoot()
        const onAcceptItem = vi.fn<(i: RenderableItem) => void>()
        const theItem = item({ id: 42, category: 'spelling' })
        showPanel(root, mkOptions({ onAcceptItem, items: [theItem] }))
        const row = root.querySelector('.gf-row-item') as HTMLElement
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onAcceptItem).toHaveBeenCalledTimes(1)
        expect(onAcceptItem.mock.calls[0]![0]?.id).toBe(42)
    })

    it('clicking the Goals pill (head) fires onOpenGoals', () => {
        const root = mkRoot()
        const onOpenGoals = vi.fn<() => void>()
        showPanel(root, mkOptions({ onOpenGoals }))
        const pill = root.querySelector('.gf-goals-pill') as HTMLElement
        pill.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onOpenGoals).toHaveBeenCalledOnce()
    })

    it('clicking the Stats tab fires onOpenStats', () => {
        const root = mkRoot()
        const onOpenStats = vi.fn<() => void>()
        showPanel(root, mkOptions({ onOpenStats }))
        const tab = root.querySelector('[data-action="open-stats"]') as HTMLElement
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onOpenStats).toHaveBeenCalledOnce()
    })

    it('clicking the Review tab fires onOpenReview (Stats→Review switch)', () => {
        // Bug-fix: the Review tab had no data-action, so clicking it was a
        // no-op. The orchestrator's onOpenReview destroys the Stats view and
        // re-renders the review body content.
        const root = mkRoot()
        const onOpenReview = vi.fn<() => void>()
        showPanel(root, mkOptions({ onOpenReview }))
        const tab = root.querySelector('[data-action="open-review"]') as HTMLElement
        expect(tab).not.toBeNull()
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onOpenReview).toHaveBeenCalledOnce()
    })

    it('outside pointerdown fires onClose (light-dismiss)', async () => {
        // Bug-fix: the review panel had no outside-click dismiss. A pointerdown
        // outside the panel element must fire onClose.
        // The arm timer is setTimeout(0) — wait for it with a real async tick.
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showPanel(root, mkOptions({ onClose }))
        // Wait for the arm timer (setTimeout 0) to fire.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        // Pointerdown on document.body (outside the panel) → should close.
        const outside = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })
        document.body.dispatchEvent(outside)
        expect(onClose).toHaveBeenCalledOnce()
    })

    it('a pointerdown inside a sibling .gf-rephrase (rephrase result card) does NOT close the panel', async () => {
        // Placement audit regression: the panel's "Rephrase message" button
        // opens the rephrase-card flow WITHOUT closing the panel, but the
        // outside-dismiss exclusion list omitted `.gf-rephrase` (and
        // `.gf-rephrase-btn`) — so interacting with a rephrase card opened
        // from inside the panel immediately dismissed the panel underneath
        // it as a false "outside click".
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showPanel(root, mkOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const rephraseCard = document.createElement('div')
        rephraseCard.className = 'gf-rephrase'
        root.appendChild(rephraseCard)
        const inside = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })
        rephraseCard.dispatchEvent(inside)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('a pointerdown inside a sibling .gf-rephrase-btn (split control) does NOT close the panel', async () => {
        const root = mkRoot()
        const onClose = vi.fn<() => void>()
        showPanel(root, mkOptions({ onClose }))
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        const control = document.createElement('div')
        control.className = 'gf-rephrase-btn'
        root.appendChild(control)
        const inside = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })
        control.dispatchEvent(inside)
        expect(onClose).not.toHaveBeenCalled()
    })

    it('reposition() re-anchors the panel to a fresh rect (placement audit — tracks the field on scroll)', () => {
        // Previously the panel had NO reposition path; the orchestrator's
        // scroll/resize loop could only destroy it, never re-anchor it, so
        // it visually drifted from the orb as the page scrolled.
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        const panel = root.querySelector('.gf-panel-aside') as HTMLElement
        const leftBefore = panel.style.left
        const topBefore = panel.style.top
        handle.reposition(new DOMRect(900, 900, 40, 20))
        // Same DOM node — reposition() moves it in place, no rebuild.
        expect(root.querySelector('.gf-panel-aside')).toBe(panel)
        const leftAfter = panel.style.left
        const topAfter = panel.style.top
        // Re-anchored to a rect far from the original ANCHOR (100,100) —
        // the position must have changed.
        expect(leftAfter === leftBefore && topAfter === topBefore).toBe(false)
    })

    it('reposition() is a safe no-op after destroy()', () => {
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        handle.destroy()
        expect(() => handle.reposition(new DOMRect(1, 2, 3, 4))).not.toThrow()
    })

    it('clicking "Disable on this site" fires onDisableSite', () => {
        const root = mkRoot()
        const onDisableSite = vi.fn<() => void>()
        showPanel(root, mkOptions({ onDisableSite }))
        const btn = root.querySelector('[data-action="disable-site"]') as HTMLElement
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        expect(onDisableSite).toHaveBeenCalledOnce()
    })

    it('positioning: places the panel anchored to the orb (above OR below) and within the viewport', () => {
        const root = mkRoot()
        // The panel anchors to the orb's bottom-right corner and expands
        // above; if there's no room above it flips below. Either way the
        // panel must be inside the viewport and right-aligned to the
        // anchor (or clamped to the viewport gutter).
        showPanel(root, mkOptions())
        const panel = root.querySelector('.gf-panel-aside') as HTMLElement
        const top = parseInt(panel.style.top, 10)
        const left = parseInt(panel.style.left, 10)
        expect(Number.isFinite(top)).toBe(true)
        expect(Number.isFinite(left)).toBe(true)
        expect(left).toBeGreaterThanOrEqual(0)
        // The panel is inside the viewport: top + height <= vh (or close
        // — the fallback PANEL_HEIGHT_FALLBACK is 480, so a tall panel
        // just sits at the top edge).
        expect(top).toBeGreaterThanOrEqual(0)
    })

    it('a new showPanel() dismisses the prior (one panel per root)', () => {
        const root = mkRoot()
        showPanel(root, mkOptions())
        showPanel(root, mkOptions())
        expect(root.querySelectorAll('.gf-panel-aside')).toHaveLength(1)
    })

    it('a re-open destroys the PREVIOUS handle, not just its DOM (item 3: no orphaned window listener)', async () => {
        // ROOT CAUSE: destroyExisting() used to only
        // querySelectorAll('.gf-panel-aside').remove() — the prior
        // handle's destroy() (which removes its installOutsideDismiss
        // window pointerdown listener) never ran. Fixed via a per-root
        // registry (mirrors popover.ts / rephrase-card.ts) that
        // destroyExisting() now drains through real destroy() calls.
        const root = mkRoot()
        const onClose1 = vi.fn<() => void>()
        const first = showPanel(root, mkOptions({ onClose: onClose1 }))
        expect(first.isOpen()).toBe(true)
        // installOutsideDismiss arms its window pointerdown listener after
        // a setTimeout(0) — wait a tick so the FIRST panel's listener is
        // actually installed (the state a real re-open would find).
        await new Promise<void>((r) => setTimeout(r, 0))

        const removeSpy = vi.spyOn(window, 'removeEventListener')
        const onClose2 = vi.fn<() => void>()
        const second = showPanel(root, mkOptions({ onClose: onClose2 }))

        // The first handle must be FULLY torn down, not just its DOM node.
        expect(first.isOpen()).toBe(false)
        const removedTypes = removeSpy.mock.calls.map((c) => c[0])
        expect(removedTypes).toContain('pointerdown')
        removeSpy.mockRestore()

        // An outside pointerdown fires ONLY the live (second) panel's
        // onClose — a leaked first-handle listener would double-fire.
        await new Promise<void>((r) => setTimeout(r, 0))
        document.body.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true }),
        )
        expect(onClose1).not.toHaveBeenCalled()
        expect(onClose2).toHaveBeenCalledTimes(1)
        expect(second.isOpen()).toBe(true)
    })

    it('destroy() removes the panel; isOpen() reports false afterwards', () => {
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        expect(handle.isOpen()).toBe(true)
        handle.destroy()
        expect(handle.isOpen()).toBe(false)
        expect(root.querySelector('.gf-panel-aside')).toBeNull()
    })

    it('getBodyContainer() returns the live .gf-panel__body while open (the W2-4 mountStatsView slot)', () => {
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        expect(handle.getBodyContainer()).toBe(root.querySelector('.gf-panel__body'))
    })

    it('getBodyContainer() returns null after destroy() (so a caller cannot mount into a dead container)', () => {
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        handle.destroy()
        expect(handle.getBodyContainer()).toBeNull()
    })

    it('destroy() is idempotent (safe to call twice)', () => {
        const root = mkRoot()
        const handle = showPanel(root, mkOptions())
        handle.destroy()
        expect(() => handle.destroy()).not.toThrow()
    })

    // W3-3b: the panel's `disabled` prop swaps the body for a paused
    // empty-state. The head + tabs + footer stay mounted (so the user
    // can close / re-enable without a second mount).
    describe('disabled (W3-3b paused empty-state)', () => {
        it('renders the paused empty-state instead of the score/list body when disabled=true', () => {
            const root = mkRoot()
            showPanel(root, mkOptions({ disabled: true }))
            expect(root.querySelector('.gf-panel__paused')).not.toBeNull()
            expect(root.querySelector('.gf-panel__score')).toBeNull()
            expect(root.querySelector('.gf-panel__list')).toBeNull()
            // Head + tabs + footer still mounted.
            expect(root.querySelector('.gf-panel__head')).not.toBeNull()
            expect(root.querySelector('.gf-panel__tabs')).not.toBeNull()
            expect(root.querySelector('.gf-panel__footer')).not.toBeNull()
        })
        it('the "Turn on for this site" button (data-action="disable-site") fires onDisableSite', () => {
            const root = mkRoot()
            const onDisableSite = vi.fn<() => void>()
            showPanel(root, mkOptions({ disabled: true, onDisableSite }))
            // The button is the one inside .gf-panel__paused (the
            // footer also has a disable-site button, so scope the
            // selector).
            const paused = root.querySelector('.gf-panel__paused') as HTMLElement
            const btn = paused.querySelector('[data-action="disable-site"]') as HTMLElement
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
            expect(onDisableSite).toHaveBeenCalledOnce()
        })
        it('still shows the score/list body when disabled is unset (default)', () => {
            const root = mkRoot()
            showPanel(root, mkOptions())
            expect(root.querySelector('.gf-panel__paused')).toBeNull()
            expect(root.querySelector('.gf-panel__score')).not.toBeNull()
        })
        it('still shows the score/list body when disabled=false (explicit)', () => {
            const root = mkRoot()
            showPanel(root, mkOptions({ disabled: false }))
            expect(root.querySelector('.gf-panel__paused')).toBeNull()
            expect(root.querySelector('.gf-panel__score')).not.toBeNull()
        })
    })

    describe('restoreReviewBody (panel refresh after accept-all / accept-item)', () => {
        // Regression guard for the "stale panel after accept-all" bug (round 12).
        // After applying suggestions, renderField calls restoreReviewBody with
        // fresh items. The panel body must rebuild atomically (no flash) and
        // reflect the new model (empty state when no items remain).

        it('restoreReviewBody returns true and rebuilds the body with fresh items', () => {
            const root = mkRoot()
            const handle = showPanel(root, mkOptions({ items: [item({ id: 1 }), item({ id: 2 })] }))
            // Initially 2 items → "Accept all 2 suggestions" button present.
            expect(root.querySelector('[data-action="accept-all"]')).not.toBeNull()
            // Simulate accept-all: items cleared, re-check returned empty.
            const refreshed = handle.restoreReviewBody([], 'I have an apple.', neutralGoals, 'done', true)
            expect(refreshed).toBe(true)
            // After refresh: no accept-all button (no items), no suggestion rows.
            expect(root.querySelector('[data-action="accept-all"]')).toBeNull()
            expect(root.querySelectorAll('.gf-row-item')).toHaveLength(0)
            // Score block still present (shows "No issues remaining").
            expect(root.querySelector('.gf-panel__score')).not.toBeNull()
        })

        it('restoreReviewBody returns false (no-op) when Stats tab is active (guard: no clobber)', () => {
            // When the user is on the Stats tab, a check completing must NOT
            // clobber the Stats view. restoreReviewBody returns false when
            // activeTab === 'stats'.
            const root = mkRoot()
            const handle = showPanel(root, mkOptions({ items: [item({ id: 1 })] }))
            // Switch to Stats tab (simulates user clicking Stats).
            const aside = root.querySelector('.gf-panel-aside') as HTMLElement
            if ('setActiveTab' in aside) {
                (aside as HTMLElement & { setActiveTab: (t: 'review' | 'stats') => void })
                    .setActiveTab('stats')
            }
            expect(handle.getActiveTab()).toBe('stats')
            // restoreReviewBody must be a no-op when Stats is active.
            const refreshed = handle.restoreReviewBody([], 'text', neutralGoals, 'done', false)
            expect(refreshed).toBe(false)
            // Body still has Stats content (not cleared by the no-op).
            // The body container is still connected.
            expect(handle.getBodyContainer()?.isConnected).toBe(true)
        })

        it('getActiveTab returns review initially, stats after setActiveTab(stats)', () => {
            const root = mkRoot()
            const handle = showPanel(root, mkOptions())
            expect(handle.getActiveTab()).toBe('review')
            const aside = root.querySelector('.gf-panel-aside') as HTMLElement
            if ('setActiveTab' in aside) {
                (aside as HTMLElement & { setActiveTab: (t: 'review' | 'stats') => void })
                    .setActiveTab('stats')
            }
            expect(handle.getActiveTab()).toBe('stats')
            if ('setActiveTab' in aside) {
                (aside as HTMLElement & { setActiveTab: (t: 'review' | 'stats') => void })
                    .setActiveTab('review')
            }
            expect(handle.getActiveTab()).toBe('review')
        })

        it('restoreReviewBody returns false and is a no-op after destroy()', () => {
            // Stale-guard: if the panel was closed before the re-check resolved,
            // restoreReviewBody must not throw or render onto a dead container.
            const root = mkRoot()
            const handle = showPanel(root, mkOptions())
            handle.destroy()
            const refreshed = handle.restoreReviewBody([], 'text', neutralGoals, 'done', false)
            expect(refreshed).toBe(false)
        })

        it('restoreReviewBody rebuilds with fresh items (partial accept — some remain)', () => {
            const root = mkRoot()
            const handle = showPanel(root, mkOptions({
                items: [item({ id: 1, category: 'spelling' }), item({ id: 2, category: 'grammar' })],
            }))
            // Accept the spelling item; grammar remains.
            const refreshed = handle.restoreReviewBody(
                [item({ id: 2, category: 'grammar' })],
                'I have an apple.',
                neutralGoals,
                'done',
                true,
            )
            expect(refreshed).toBe(true)
            // One group (grammar) remains.
            expect(root.querySelectorAll('.gf-group')).toHaveLength(1)
            expect(root.querySelectorAll('.gf-row-item')).toHaveLength(1)
        })
    })
})
