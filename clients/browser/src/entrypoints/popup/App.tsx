// Popup UI (React). The small status window the user clicks from the
// toolbar. Shows the bridge connection state, an Enabled toggle, a
// "Check now" button (sends TRIGGER_CHECK to the active tab), the
// focused field's per-category counts (sourced from TAB_STATUS), and a
// per-category legend so the colours on the page are interpretable.
// React is allowed in popup/options (NOT in content — see the oxlint
// `no-restricted-imports` override).
import { useCallback, useEffect, useState } from 'react'
import { BridgeClient } from '@/api/client'
import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'
import { isMessage, messageSender, sendActiveTabMessage } from '@/messaging/schema'
import { getSettings, setSettings, settingsItem, type Settings } from '@/storage/settings'

type HealthState =
    | { status: 'unknown' }
    | { status: 'ok'; premium: boolean }
    | { status: 'unreachable'; error: string }

interface TabStatus {
    enabled: boolean
    fieldCount: number
    counts: Partial<Record<Category, number>>
}

const CATEGORY_ORDER: Category[] = ['spelling', 'grammar', 'punctuation', 'style', 'typography']

const CATEGORY_LABELS: Record<Category, string> = {
    spelling: 'Spelling',
    grammar: 'Grammar',
    punctuation: 'Punctuation',
    style: 'Style',
    typography: 'Typography',
    unknown: 'Issue',
}

export function App() {
    const [settings, setSettingsState] = useState<Settings | null>(null)
    const [health, setHealth] = useState<HealthState>({ status: 'unknown' })
    const [tabStatus, setTabStatus] = useState<TabStatus | null>(null)

    const refreshHealth = useCallback(async (s: Settings): Promise<void> => {
        try {
            const client = new BridgeClient(s.bridgeBaseUrl, s.allowRemoteBridge)
            const r = await client.health()
            setHealth({ status: 'ok', premium: r.premium === true })
        } catch (e) {
            setHealth({ status: 'unreachable', error: e instanceof Error ? e.message : String(e) })
        }
    }, [])

    const refreshTabStatus = useCallback(async (): Promise<void> => {
        try {
            const reply = await sendActiveTabMessage(messageSender('GET_TAB_STATUS')())
            if (isMessage(reply, 'TAB_STATUS')) {
                setTabStatus({
                    enabled: reply.enabled,
                    fieldCount: reply.fieldCount,
                    counts: reply.counts,
                })
            }
        } catch {
            // No content script on the active tab — leave tabStatus null.
        }
    }, [])

    useEffect(() => {
        void getSettings().then(setSettingsState)
        // The watch lives until the popup unmounts (closing the toolbar
        // window); the popup has no long-lived cleanup, so we discard the
        // unsubscribe. (Popups are ephemeral; WXT closes the page when the
        // user dismisses the toolbar.)
        settingsItem.watch((next) => {
            setSettingsState(next)
            void refreshHealth(next)
            void refreshTabStatus()
        })
        void refreshTabStatus()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const onCheckNow = useCallback(async (): Promise<void> => {
        await sendActiveTabMessage(messageSender('TRIGGER_CHECK')())
        // Give the content script a moment to re-check, then refresh.
        setTimeout(() => {
            void refreshTabStatus()
        }, 200)
    }, [refreshTabStatus])

    const onToggleEnabled = useCallback(async (next: boolean): Promise<void> => {
        await setSettings({ enabled: next })
    }, [])

    if (!settings) {
        return (
            <main className="gf-popup">
                <p>Loading…</p>
            </main>
        )
    }

    const summaryEntries = tabStatus
        ? CATEGORY_ORDER.filter((c) => (tabStatus.counts[c] ?? 0) > 0)
        : []
    const totalCount = tabStatus
        ? Object.values(tabStatus.counts).reduce((a, b) => a + (b ?? 0), 0)
        : 0

    return (
        <main className="gf-popup">
            <header className="gf-popup__header">
                <h1>GrammarForge</h1>
                <p className="gf-popup__subtitle">
                    Privacy-first corrections from your local bridge.
                </p>
            </header>

            <section className="gf-popup__status" aria-live="polite">
                {health.status === 'unknown' && <span>Checking bridge…</span>}
                {health.status === 'ok' && (
                    <span className="gf-popup__ok">
                        <span
                            className="gf-popup__dot"
                            style={{ background: '#22c55e' }}
                            aria-hidden
                        />
                        Bridge reachable{health.premium ? ' · premium' : ''}
                    </span>
                )}
                {health.status === 'unreachable' && (
                    <span className="gf-popup__bad">
                        <span
                            className="gf-popup__dot"
                            style={{ background: '#ef4444' }}
                            aria-hidden
                        />
                        Bridge unreachable
                        <span className="gf-popup__err">{health.error}</span>
                    </span>
                )}
            </section>

            <label className="gf-popup__row">
                <input
                    type="checkbox"
                    checked={settings.enabled}
                    onChange={(e) => void onToggleEnabled(e.currentTarget.checked)}
                />
                <span>Enabled on this browser</span>
            </label>

            <button
                className="gf-popup__btn gf-popup__btn--primary"
                type="button"
                onClick={() => void onCheckNow()}
                disabled={!settings.enabled}
            >
                Check now
            </button>

            <section className="gf-popup__summary" aria-label="Focused field summary">
                <h2>Focused field</h2>
                {!tabStatus && <p className="gf-popup__hint">No content script on this tab.</p>}
                {tabStatus && tabStatus.fieldCount === 0 && (
                    <p className="gf-popup__hint">No editable fields detected.</p>
                )}
                {tabStatus && tabStatus.fieldCount > 0 && totalCount === 0 && (
                    <p className="gf-popup__ok">✓ No issues</p>
                )}
                {tabStatus && totalCount > 0 && (
                    <ul className="gf-popup__summary-list">
                        {summaryEntries.map((c) => (
                            <li key={c}>
                                <span
                                    className="gf-popup__swatch"
                                    style={{ background: CATEGORY_META[c].underline }}
                                    aria-hidden
                                />
                                <strong>{tabStatus.counts[c]}</strong>{' '}
                                <span>{CATEGORY_LABELS[c]}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="gf-popup__legend" aria-label="Category legend">
                <h2>Category legend</h2>
                <ul>
                    {CATEGORY_ORDER.map((c) => {
                        const meta = CATEGORY_META[c]
                        return (
                            <li
                                key={c}
                                className={`gf-popup__legend-row gf-popup__legend-row--${c}`}
                            >
                                <span
                                    className="gf-popup__swatch"
                                    style={{ background: meta.underline }}
                                    aria-hidden
                                />
                                <span>{meta.label}</span>
                            </li>
                        )
                    })}
                </ul>
            </section>
        </main>
    )
}
