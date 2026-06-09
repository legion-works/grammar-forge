// Options/settings UI (React). The full settings page: bridge URL + a
// "Test connection" button (which calls client.health()), the
// allowRemoteBridge opt-in with a privacy warning, the blocked-sites list
// (add/remove), checkMode / checkPastedText / picky / autocorrect toggles,
// the personal dictionary, and the privacy banner. React is allowed in
// popup/options (NOT in content — see the oxlint `no-restricted-imports`
// override).
import { useCallback, useEffect, useState } from 'react'
import { BridgeClient } from '@/api/client'
import { getSettings, setSettings, type Settings } from '@/storage/settings'

type HealthState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'ok'; premium: boolean }
    | { status: 'unreachable'; error: string }

const HOTKEYS: { value: Settings['acceptHotkey']; label: string }[] = [
    { value: 'Alt+Enter', label: 'Alt + Enter  (default)' },
    { value: 'Ctrl+Enter', label: 'Ctrl + Enter' },
    { value: 'Ctrl+Shift+Enter', label: 'Ctrl + Shift + Enter' },
    { value: 'Alt+.', label: 'Alt + .' },
    { value: 'Ctrl+Shift+.', label: 'Ctrl + Shift + .' },
    { value: 'Ctrl+.', label: 'Ctrl + .' },
]

export function App() {
    const [settings, setSettingsState] = useState<Settings | null>(null)
    const [health, setHealth] = useState<HealthState>({ status: 'idle' })
    const [draftUrl, setDraftUrl] = useState('')
    const [draftBlocked, setDraftBlocked] = useState('')
    const [draftDict, setDraftDict] = useState('')

    useEffect(() => {
        void getSettings().then((s) => {
            setSettingsState(s)
            setDraftUrl(s.bridgeBaseUrl)
        })
    }, [])

    const patch = useCallback(async (p: Partial<Settings>): Promise<void> => {
        await setSettings(p)
        const next = await getSettings()
        setSettingsState(next)
    }, [])

    const onTestConnection = useCallback(async (): Promise<void> => {
        if (!settings) return
        setHealth({ status: 'checking' })
        try {
            const client = new BridgeClient(draftUrl, settings.allowRemoteBridge)
            const r = await client.health()
            setHealth({ status: 'ok', premium: r.premium === true })
        } catch (e) {
            setHealth({ status: 'unreachable', error: e instanceof Error ? e.message : String(e) })
        }
    }, [settings, draftUrl])

    const onSaveUrl = useCallback(async (): Promise<void> => {
        await patch({ bridgeBaseUrl: draftUrl })
    }, [patch, draftUrl])

    const onAddBlocked = useCallback(async (): Promise<void> => {
        if (!settings) return
        const host = draftBlocked.trim().toLowerCase()
        if (!host) return
        if (settings.blockedSites.includes(host)) {
            setDraftBlocked('')
            return
        }
        await patch({ blockedSites: [...settings.blockedSites, host] })
        setDraftBlocked('')
    }, [patch, settings, draftBlocked])

    const onRemoveBlocked = useCallback(
        async (host: string): Promise<void> => {
            if (!settings) return
            await patch({ blockedSites: settings.blockedSites.filter((h) => h !== host) })
        },
        [patch, settings],
    )

    const onAddDict = useCallback(async (): Promise<void> => {
        if (!settings) return
        const word = draftDict.trim().toLowerCase()
        if (!word) return
        if (settings.personalDictionary.includes(word)) {
            setDraftDict('')
            return
        }
        await patch({ personalDictionary: [...settings.personalDictionary, word] })
        setDraftDict('')
    }, [patch, settings, draftDict])

    const onRemoveDict = useCallback(
        async (word: string): Promise<void> => {
            if (!settings) return
            await patch({
                personalDictionary: settings.personalDictionary.filter((w) => w !== word),
            })
        },
        [patch, settings],
    )

    if (!settings) {
        return (
            <main className="gf-options">
                <p>Loading…</p>
            </main>
        )
    }

    return (
        <main className="gf-options">
            <header>
                <h1>GrammarForge settings</h1>
                <p className="gf-options__lead">
                    Privacy-first grammar corrections from your self-hosted bridge.
                </p>
            </header>

            <aside className="gf-options__privacy" role="note">
                <strong>Privacy</strong>
                All processing happens on your configured local bridge. No telemetry, no analytics,
                no third-party calls. Settings and your personal dictionary are stored locally in
                this browser only (never synced).
            </aside>

            <section className="gf-options__section">
                <h2>Bridge</h2>
                <div className="gf-options__row">
                    <label htmlFor="gf-bridge-url">Bridge URL</label>
                    <input
                        id="gf-bridge-url"
                        type="url"
                        value={draftUrl}
                        onChange={(e) => setDraftUrl(e.currentTarget.value)}
                        placeholder="http://localhost:8000"
                    />
                    <button
                        className="gf-options__btn"
                        type="button"
                        onClick={() => void onSaveUrl()}
                    >
                        Save
                    </button>
                </div>
                <div className="gf-options__row">
                    <button
                        className="gf-options__btn"
                        type="button"
                        onClick={() => void onTestConnection()}
                    >
                        Test connection
                    </button>
                    <span className="gf-options__health" aria-live="polite">
                        {health.status === 'idle' && <span>Not tested</span>}
                        {health.status === 'checking' && <span>Checking…</span>}
                        {health.status === 'ok' && (
                            <span style={{ color: '#22c55e' }}>
                                ✓ Reachable{health.premium ? ' · premium' : ''}
                            </span>
                        )}
                        {health.status === 'unreachable' && (
                            <span style={{ color: '#ef4444' }}>✗ Unreachable — {health.error}</span>
                        )}
                    </span>
                </div>
                <div className="gf-options__row">
                    <label htmlFor="gf-allow-remote">
                        <input
                            id="gf-allow-remote"
                            type="checkbox"
                            checked={settings.allowRemoteBridge}
                            onChange={(e) =>
                                void patch({ allowRemoteBridge: e.currentTarget.checked })
                            }
                        />{' '}
                        Allow non-local bridge URLs
                    </label>
                </div>
                {settings.allowRemoteBridge && (
                    <p className="gf-options__warning">
                        Warning: a non-local bridge receives your text. Only enable this if you
                        trust the server operator and the network path.
                    </p>
                )}
            </section>

            <section className="gf-options__section">
                <h2>Behaviour</h2>
                <div className="gf-options__row">
                    <label htmlFor="gf-check-mode">Check mode</label>
                    <select
                        id="gf-check-mode"
                        value={settings.checkMode}
                        onChange={(e) =>
                            void patch({
                                checkMode: e.currentTarget.value as Settings['checkMode'],
                            })
                        }
                    >
                        <option value="realtime">Realtime (as you type)</option>
                        <option value="ondemand">On demand only (via hotkey)</option>
                    </select>
                </div>
                <div className="gf-options__row">
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.checkPastedText}
                            onChange={(e) =>
                                void patch({ checkPastedText: e.currentTarget.checked })
                            }
                        />{' '}
                        Check pasted text
                    </label>
                </div>
                <div className="gf-options__row">
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.picky}
                            onChange={(e) => void patch({ picky: e.currentTarget.checked })}
                        />{' '}
                        Picky (include style suggestions)
                    </label>
                </div>
                <div className="gf-options__row">
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.autocorrect}
                            onChange={(e) => void patch({ autocorrect: e.currentTarget.checked })}
                        />{' '}
                        Autocorrect (auto-apply high-confidence fixes — off by default)
                    </label>
                </div>
            </section>

            <section className="gf-options__section">
                <h2>Hotkey</h2>
                <div className="gf-options__row">
                    <label htmlFor="gf-accept-hotkey">Accept suggestion</label>
                    <select
                        id="gf-accept-hotkey"
                        value={settings.acceptHotkey}
                        onChange={(e) =>
                            void patch({
                                acceptHotkey: e.currentTarget.value as Settings['acceptHotkey'],
                            })
                        }
                    >
                        {HOTKEYS.map((h) => (
                            <option key={h.value} value={h.value}>
                                {h.label}
                            </option>
                        ))}
                    </select>
                </div>
            </section>

            <section className="gf-options__section">
                <h2>Blocked sites</h2>
                <p className="gf-options__lead" style={{ margin: '0 0 6px' }}>
                    GrammarForge is enabled on every site except these. Add exact hostnames (no
                    subdomains).
                </p>
                <ul className="gf-options__list">
                    {settings.blockedSites.map((host) => (
                        <li key={host} className="gf-options__chip">
                            <span>{host}</span>
                            <button
                                type="button"
                                onClick={() => void onRemoveBlocked(host)}
                                aria-label={`Remove ${host}`}
                            >
                                ✕
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="gf-options__add">
                    <input
                        type="text"
                        value={draftBlocked}
                        onChange={(e) => setDraftBlocked(e.currentTarget.value)}
                        placeholder="example.com"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void onAddBlocked()
                        }}
                    />
                    <button
                        className="gf-options__btn"
                        type="button"
                        onClick={() => void onAddBlocked()}
                    >
                        Add
                    </button>
                </div>
            </section>

            <section className="gf-options__section">
                <h2>Personal dictionary</h2>
                <p className="gf-options__lead" style={{ margin: '0 0 6px' }}>
                    Local only. Words you add here are skipped by the spelling category on this
                    device.
                </p>
                <ul className="gf-options__list">
                    {settings.personalDictionary.map((word) => (
                        <li key={word} className="gf-options__chip">
                            <span>{word}</span>
                            <button
                                type="button"
                                onClick={() => void onRemoveDict(word)}
                                aria-label={`Remove ${word}`}
                            >
                                ✕
                            </button>
                        </li>
                    ))}
                </ul>
                <div className="gf-options__add">
                    <input
                        type="text"
                        value={draftDict}
                        onChange={(e) => setDraftDict(e.currentTarget.value)}
                        placeholder="word or phrase"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') void onAddDict()
                        }}
                    />
                    <button
                        className="gf-options__btn"
                        type="button"
                        onClick={() => void onAddDict()}
                    >
                        Add
                    </button>
                </div>
            </section>
        </main>
    )
}
