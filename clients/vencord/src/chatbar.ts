// Vencord chat-bar button: Translate-style slot in the message composer's
// chrome. Hover surfaces the orchestrator's status pill; click toggles its
// corrections panel. Live count badge re-renders on orchestrator
// notifications. Dimmed when paused. React + ChatBarButton stay EXTERNAL
// (Vencord resolves them at its own build time) — no JSX, all createElement
// so this file is `.ts`, not `.tsx`.
import { ChatBarButton } from '@api/ChatButtons'
import { React } from '@webpack/common'
import type { OrchestratorApi } from './orchestrator'
import { tooltipFor } from './chatbar-tooltip'

const HIDE_PILL_DELAY_MS = 300

// The Forge Caret mark (LOGO.md), mono variant: caret polyline + molten
// core, both `currentColor`, with the 4-tick category baseline at reduced
// opacity (spec: "Monochrome ... inherits currentColor (caret + core solid,
// baseline at 0.5 opacity)"). Replaces the retired pencil-and-ruler glyph.
// 48×48 viewBox (LOGO.md geometry); rendered at 20px in the chatbar slot —
// per LOGO.md, below ~24px the baseline ticks visually merge with the caret,
// which is expected (the caret + core still read as the mark).
const MARK_VIEWBOX = '0 0 48 48'
const MARK_CARET_PATH = 'M12.5 28.5 L24 14 L35.5 28.5'
const MARK_BASELINE_TICKS: ReadonlyArray<[number, number]> = [
    [12.5, 16.75],
    [18.75, 23],
    [25, 29.25],
    [31.25, 35.5],
]

// Power glyph (24×24, currentColor stroke). W3-3b: the chatbar icon swaps
// to this glyph when the site is paused — the user sees a single
// "this is off" affordance that mirrors the orb's power state.
const POWER_ICON_PATH =
    'M12 4 L12 12 M7.5 6.5 A7 7 0 1 0 16.5 6.5'

// Legion Works dark-theme values (LOGO.md / handoff/scss/_tokens.scss).
// The chatbar button renders in Discord's own React tree, OUTSIDE the
// GrammarForge overlay shadow root — the `--gf-*` custom properties the
// shared overlay CSS defines are scoped to that shadow host and do not
// cascade here, so the Legion values are inlined directly. Vencord's GF
// root is always dark (orchestrator.ts pins data-gf-theme="dark"), so only
// the dark-theme values are needed.
const LEGION_ACCENT = '#86e1fc' // --accent (dark)
const LEGION_ACCENT_INK = '#0c1622' // --accent-ink — dark ink text ON cyan, never white
const LEGION_PURPLE = '#c099ff' // --purple-400 (Geth Purple, AI refining pip)
const LEGION_SUCCESS = '#c3e88d' // --success (Tokyo green, all-clear)

const CHATBAR_STYLE_ID = 'grammarforge-chatbar-style'
// One-time, idempotent keyframe injection for the AI-refining pip's pulse.
// Scoped to a GrammarForge-prefixed class (not the shared overlay's
// `.gfd-pip`) since this button lives outside the overlay shadow root.
// Entrance rule (INSTRUCTIONS.md §G) does not apply here — this is a
// continuous loop that starts/ends at opacity:1, not an entrance transition,
// so reduced-motion users simply see the resting (opacity:1) frame.
function ensureChatbarStyles(): void {
    if (document.getElementById(CHATBAR_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = CHATBAR_STYLE_ID
    style.textContent = `
@keyframes gf-vencord-pip { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.16); opacity: 0.82; } }
.gf-vencord-pip { animation: gf-vencord-pip 1100ms ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .gf-vencord-pip { animation: none; } }
`
    document.head.appendChild(style)
}

const DEFAULT_SUMMARY: {
    count: number
    byCategory: Record<string, number>
    paused: boolean
    phase: 'fast' | 'done'
} = {
    count: 0,
    byCategory: {},
    paused: false,
    phase: 'done',
}

// Outer wrapper: the inner ChatBarButton wires its OWN onMouseEnter /
// onMouseLeave to the Tooltip render prop; spreading our own via
// `buttonProps` would override them and break the tooltip. Wrapping in a
// span keeps the tooltip working AND gives us a place to debounce the
// pill's hide, anchor the badge, and own the rect for showPill.
function makeRender(getApi: () => OrchestratorApi | null) {
    return function render(_props: { isMainChat: boolean; isAnyChat: boolean }) {
        return React.createElement(ChatBarButtonRoot, { getApi })
    }
}

interface ChatBarButtonRootProps {
    getApi: () => OrchestratorApi | null
}

function ChatBarButtonRoot(props: ChatBarButtonRootProps) {
    const [, setTick] = React.useState(0)
    const hideTimerRef = React.useRef<number | null>(null)
    const { getApi } = props
    // Hold getApi in a ref so the subscribe-once effect can read the live
    // callback at FIRE time (start() / stop() may have flipped the
    // orchestrator ref) without re-running the effect. The linter accepts
    // refs as stable deps; the closure captures the ref, not the function.
    const getApiRef = React.useRef(getApi)
    getApiRef.current = getApi

    React.useEffect(() => {
        ensureChatbarStyles()
        const api = getApiRef.current()
        if (!api) return
        const unsubscribe = api.subscribe(() => setTick((t) => t + 1))
        return () => {
            unsubscribe()
            if (hideTimerRef.current != null) {
                window.clearTimeout(hideTimerRef.current)
                hideTimerRef.current = null
            }
        }
    }, [])

    const api = getApi()
    const summary = api?.getSummary() ?? DEFAULT_SUMMARY
    const tooltip = tooltipFor(summary)
    // Badge states (flows.md §6, Vencord column): count>0 → numeric badge
    // (Legion cyan fill, dark ink text — never white-on-cyan); zero
    // suggestions while the LLM pass is still in flight → the pulsing ✨
    // pip; zero suggestions once settled → the green all-clear check.
    // Paused hides the badge entirely — the icon's power glyph is the
    // single "this is off" affordance (no redundant second signal).
    const badgeState: 'count' | 'pip' | 'clean' | null = summary.paused
        ? null
        : summary.count > 0
          ? 'count'
          : summary.phase === 'fast'
            ? 'pip'
            : 'clean'

    const cancelHide = (): void => {
        if (hideTimerRef.current != null) {
            window.clearTimeout(hideTimerRef.current)
            hideTimerRef.current = null
        }
    }
    const onEnter = (e: { currentTarget: HTMLElement }): void => {
        cancelHide()
        const rect = e.currentTarget.getBoundingClientRect()
        const a = getApi()
        if (a) a.showPill(rect)
    }
    const onLeave = (): void => {
        cancelHide()
        const a = getApi()
        if (!a) return
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null
            // Re-read at fire time — start()/stop() may have flipped the ref
            // during the grace window.
            getApi()?.hidePill()
        }, HIDE_PILL_DELAY_MS)
    }
    const onClick = (e: { currentTarget: HTMLElement }): void => {
        getApi()?.togglePanel(e.currentTarget.getBoundingClientRect())
    }

    return React.createElement(
        'div',
        {
            style: { position: 'relative', display: 'inline-flex' },
            onMouseEnter: onEnter,
            onMouseLeave: onLeave,
            'aria-label': tooltip,
            // Mark this wrapper so the blur handler in the orchestrator can
            // detect "focus moved to the GF chatbar button" and skip the
            // items-clear. Without this, clicking the chatbar button blurs
            // the composer → items cleared → panel opens empty.
            'data-grammarforge-ui': 'chatbar',
        },
        React.createElement(
            ChatBarButton,
            {
                tooltip,
                onClick,
                buttonProps: { 'aria-label': tooltip },
            },
            // W3-3b: when paused, the chatbar icon swaps to the power
            // glyph (matches the orb's disabled state) instead of the
            // Forge Caret mark. Both are visually distinct from the
            // active state; the power glyph wins for a single,
            // unambiguous "this is off" signal.
            summary.paused
                ? React.createElement(
                      'svg',
                      {
                          viewBox: '0 0 24 24',
                          height: 20,
                          width: 20,
                          fill: 'none',
                          stroke: 'currentColor',
                          'stroke-width': 2.2,
                          'stroke-linecap': 'round',
                          'stroke-linejoin': 'round',
                          style: { opacity: 0.85 },
                      },
                      React.createElement('path', { d: POWER_ICON_PATH }),
                  )
                : renderMarkIcon(20, 20),
        ),
        badgeState === 'count'
            ? React.createElement(
                  'span',
                  {
                      'data-grammarforge-badge': '',
                      style: {
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          minWidth: 16,
                          height: 16,
                          borderRadius: 8,
                          background: LEGION_ACCENT,
                          color: LEGION_ACCENT_INK,
                          fontSize: 11,
                          fontWeight: 700,
                          lineHeight: '16px',
                          textAlign: 'center',
                          padding: '0 4px',
                          pointerEvents: 'none',
                          boxShadow: '0 0 0 2px var(--background-base-low, #313338)',
                      },
                  },
                  String(summary.count),
              )
            : badgeState === 'pip'
              ? React.createElement(
                    'span',
                    {
                        'data-grammarforge-badge': '',
                        className: 'gf-vencord-pip',
                        style: {
                            position: 'absolute',
                            top: -3,
                            right: -3,
                            width: 15,
                            height: 15,
                            borderRadius: 8,
                            background: `linear-gradient(135deg, ${LEGION_PURPLE}, ${LEGION_ACCENT})`,
                            color: '#fff',
                            fontSize: 9,
                            fontWeight: 700,
                            lineHeight: '15px',
                            textAlign: 'center',
                            pointerEvents: 'none',
                            boxShadow: '0 0 0 2px var(--background-base-low, #313338)',
                        },
                    },
                    '✨',
                )
              : badgeState === 'clean'
                ? React.createElement(
                      'span',
                      {
                          'data-grammarforge-badge': '',
                          style: {
                              position: 'absolute',
                              top: -2,
                              right: -2,
                              width: 13,
                              height: 13,
                              borderRadius: '50%',
                              background: LEGION_SUCCESS,
                              boxShadow: '0 0 0 2px var(--background-base-low, #313338)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              pointerEvents: 'none',
                          },
                      },
                      React.createElement(
                          'svg',
                          {
                              viewBox: '0 0 24 24',
                              width: 9,
                              height: 9,
                              fill: 'none',
                              stroke: LEGION_ACCENT_INK,
                              'stroke-width': 3.5,
                              'stroke-linecap': 'round',
                              'stroke-linejoin': 'round',
                          },
                          React.createElement('path', { d: 'M5 13l4 4L19 7' }),
                      ),
                  )
                : null,
    )
}

// Shared mono Forge Caret icon (chatbar button + Vencord plugin-list icon).
function renderMarkIcon(height: number | string, width: number | string, className?: string) {
    return React.createElement(
        'svg',
        {
            viewBox: MARK_VIEWBOX,
            height,
            width,
            className,
            fill: 'none',
            stroke: 'currentColor',
        },
        React.createElement(
            'g',
            { 'stroke-width': 2.6, 'stroke-linecap': 'round', opacity: 0.5 },
            ...MARK_BASELINE_TICKS.map(([x1, x2], i) =>
                React.createElement('line', { key: i, x1, y1: 37.5, x2, y2: 37.5 }),
            ),
        ),
        React.createElement('path', {
            d: MARK_CARET_PATH,
            'stroke-width': 4.4,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        }),
        React.createElement('circle', { cx: 24, cy: 14, r: 3.5, fill: 'currentColor', stroke: 'none' }),
    )
}

function makeIcon() {
    return function icon(props: {
        height?: number | string
        width?: number | string
        className?: string
    }) {
        const { height = 20, width = 20, className } = props
        return renderMarkIcon(height, width, className)
    }
}

export function makeChatBarButton(getApi: () => OrchestratorApi | null): {
    render: (props: { isMainChat: boolean; isAnyChat: boolean }) => unknown
    icon: (props: {
        height?: number | string
        width?: number | string
        className?: string
    }) => unknown
} {
    return {
        render: makeRender(getApi),
        icon: makeIcon(),
    }
}
