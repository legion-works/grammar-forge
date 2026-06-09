// Popup UI (React). Tabbed interface: Status tab shows bridge health, per-site
// power toggle, enabled toggle, "Check now", and the focused-field summary.
// Settings tab embeds the shared SettingsForm and an "Open full settings page"
// link. React is allowed in popup/options (NOT in content — see the oxlint
// `no-restricted-imports` override).
import { useCallback, useEffect, useState } from 'react'
import { BridgeClient } from '@/api/client'
import { CATEGORY_META } from '@/api/category'
import type { Category } from '@/api/types'
import { isMessage, messageSender, sendActiveTabMessage } from '@/messaging/schema'
import {
    getSettings,
    isSiteBlocked,
    setSettings,
    settingsItem,
    type Settings,
} from '@/storage/settings'
import { SettingsForm } from '@/entrypoints/settings/SettingsForm'

type HealthState =
    | { status: 'unknown' }
    | { status: 'ok'; premium: boolean }
    | { status: 'unreachable'; error: string }

interface TabStatus {
    enabled: boolean
    fieldCount: number
    hostname: string
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

type TabKey = 'status' | 'settings'

export function App() {
    const [settings, setSettingsState] = useState<Settings | null>(null)
    const [health, setHealth] = useState<HealthState>({ status: 'unknown' })
    const [tabStatus, setTabStatus] = useState<TabStatus | null>(null)
    const [tab, setTab] = useState<TabKey>('status')

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
                    hostname: reply.hostname,
                    counts: reply.counts,
                })
            }
        } catch {
            // No content script on the active tab — leave tabStatus null.
        }
    }, [])

    useEffect(() => {
        void getSettings().then(setSettingsState)
        settingsItem.watch((next) => {
            setSettingsState(next)
            void refreshHealth(next)
            void refreshTabStatus()
        })
        void refreshTabStatus()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (settings) void refreshHealth(settings)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings?.bridgeBaseUrl, settings?.allowRemoteBridge])

    const onCheckNow = useCallback(async (): Promise<void> => {
        await sendActiveTabMessage(messageSender('TRIGGER_CHECK')())
        setTimeout(() => {
            void refreshTabStatus()
        }, 200)
    }, [refreshTabStatus])

    const onToggleEnabled = useCallback(async (next: boolean): Promise<void> => {
        await setSettings({ enabled: next })
    }, [])

    const sitePaused = settings && tabStatus ? isSiteBlocked(settings, tabStatus.hostname) : false

    const onTogglePower = useCallback(async (): Promise<void> => {
        if (!settings || !tabStatus?.hostname) return
        const host = tabStatus.hostname
        const blocked = isSiteBlocked(settings, host)
        await setSettings({
            blockedSites: blocked
                ? settings.blockedSites.filter((h) => h !== host)
                : [...settings.blockedSites, host],
        })
    }, [settings, tabStatus])

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

            <div className="gf-popup__tabs" role="tablist" aria-label="GrammarForge">
                <button
                    role="tab"
                    type="button"
                    id="gf-tab-status"
                    aria-selected={tab === 'status'}
                    aria-controls="gf-panel-status"
                    className={`gf-popup__tab${tab === 'status' ? ' gf-popup__tab--active' : ''}`}
                    onClick={() => setTab('status')}
                >
                    Status
                </button>
                <button
                    role="tab"
                    type="button"
                    id="gf-tab-settings"
                    aria-selected={tab === 'settings'}
                    aria-controls="gf-panel-settings"
                    className={`gf-popup__tab${tab === 'settings' ? ' gf-popup__tab--active' : ''}`}
                    onClick={() => setTab('settings')}
                >
                    Settings
                </button>
            </div>

            {tab === 'status' && (
                <div role="tabpanel" id="gf-panel-status" aria-labelledby="gf-tab-status">
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
                                Bridge unreachable — is it running at {settings.bridgeBaseUrl}?
                                <span className="gf-popup__err">{health.error}</span>
                            </span>
                        )}
                    </section>

                    {tabStatus?.hostname && (
                        <div className="gf-popup__row">
                            <button
                                className={`gf-popup__btn${sitePaused ? '' : ' gf-popup__btn--primary'}`}
                                type="button"
                                onClick={() => void onTogglePower()}
                            >
                                {sitePaused
                                    ? `Resume on ${tabStatus.hostname}`
                                    : `Pause on ${tabStatus.hostname}`}
                            </button>
                        </div>
                    )}

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
                        {!tabStatus && (
                            <p className="gf-popup__hint">
                                No GrammarForge on this tab — try reloading the page.
                            </p>
                        )}
                        {tabStatus && tabStatus.fieldCount === 0 && (
                            <p className="gf-popup__hint">
                                No editable field detected. Click into a text box to start checking.
                            </p>
                        )}
                        {tabStatus && tabStatus.fieldCount > 0 && totalCount === 0 && (
                            <p className="gf-popup__ok gf-popup__ok--clean">✓ Looks clean</p>
                        )}
                        {tabStatus && totalCount > 0 && (
                            <ul className="gf-popup__summary-list">
                                {summaryEntries.map((c) => (
                                    <li key={c}>
                                        <span
                                            className="gf-popup__swatch"
                                            style={{ background: CATEGORY_META[c].tint }}
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
                                            style={{ background: meta.tint }}
                                            aria-hidden
                                        />
                                        <span>{meta.label}</span>
                                    </li>
                                )
                            })}
                        </ul>
                    </section>
                </div>
            )}

            {tab === 'settings' && (
                <div role="tabpanel" id="gf-panel-settings" aria-labelledby="gf-tab-settings">
                    <SettingsForm />
                    <button
                        className="gf-popup__btn"
                        type="button"
                        onClick={() => void browser.runtime.openOptionsPage()}
                    >
                        Open full settings page
                    </button>
                </div>
            )}
        </main>
    )
}
