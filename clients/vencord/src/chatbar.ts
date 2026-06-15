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

// Material Symbols "edit" path, 24×24 viewBox, currentColor fill — the
// universal pencil-and-ruler mark for writing assistance.
const ICON_PATH =
    'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'

// Power glyph (24×24, currentColor stroke). W3-3b: the chatbar icon swaps
// to this glyph when the site is paused — the user sees a single
// "this is off" affordance that mirrors the orb's power state.
const POWER_ICON_PATH =
    'M12 4 L12 12 M7.5 6.5 A7 7 0 1 0 16.5 6.5'

const DEFAULT_SUMMARY: { count: number; byCategory: Record<string, number>; paused: boolean } = {
    count: 0,
    byCategory: {},
    paused: false,
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
    const showBadge = summary.count > 0

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
            // pencil-with-low-opacity affordance. Both are visually
            // distinct from the active state; the power glyph wins for
            // a single, unambiguous "this is off" signal.
            React.createElement(
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
                    style: summary.paused ? { opacity: 0.85 } : undefined,
                },
                React.createElement('path', {
                    d: summary.paused ? POWER_ICON_PATH : ICON_PATH,
                }),
            ),
        ),
        showBadge
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
                          background: 'var(--brand-experiment-560, #5865f2)',
                          color: 'white',
                          fontSize: 11,
                          fontWeight: 600,
                          lineHeight: '16px',
                          textAlign: 'center',
                          padding: '0 4px',
                          pointerEvents: 'none',
                      },
                  },
                  String(summary.count),
              )
            : null,
    )
}

function makeIcon() {
    return function icon(props: {
        height?: number | string
        width?: number | string
        className?: string
    }) {
        const { height = 20, width = 20, className } = props
        return React.createElement(
            'svg',
            {
                viewBox: '0 0 24 24',
                height,
                width,
                className,
                fill: 'currentColor',
            },
            React.createElement('path', { d: ICON_PATH }),
        )
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
