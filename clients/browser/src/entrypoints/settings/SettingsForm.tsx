// Shared settings form consumed by both the full options page and the popup's
// settings tab. Holds all stateful logic and JSX for Bridge / Behaviour /
// Hotkey / Blocked sites / Personal dictionary sections.
import { useCallback, useEffect, useState } from 'react'
import { BridgeClient } from '@/api/client'
import { getSettings, setSettings, type Settings } from '@/storage/settings'

type HealthState =
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'ok'; premium: boolean }
    | { status: 'unreachable'; error: string }

// Values use PHYSICAL key names (event.code: Period, Comma, Enter, Backslash,
// KeyJ) so the chord matches regardless of keyboard layout or the shifted glyph
// the OS produces (a `.`-glyph chord can never match Shift+. → '>'; see
// hotkeys/accept.ts matchesHotkey). Avoid Enter as a default (it inserts a
// newline in textareas).
const HOTKEYS: { value: Settings['acceptHotkey']; label: string }[] = [
    { value: 'Alt+Period', label: 'Alt + .  (default)' },
    { value: 'Ctrl+Period', label: 'Ctrl + .' },
    { value: 'Ctrl+Shift+Period', label: 'Ctrl + Shift + .' },
    { value: 'Alt+Comma', label: 'Alt + ,' },
    { value: 'Ctrl+Shift+Comma', label: 'Ctrl + Shift + ,' },
    { value: 'Ctrl+Shift+Enter', label: 'Ctrl + Shift + Enter' },
]

export function SettingsForm() {
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
        return <p className="gf-options__lead">Loading…</p>
    }

    return (
        <>
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
                <div className="gf-options__row">
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.suppressNativeSpellcheck}
                            onChange={(e) =>
                                void patch({ suppressNativeSpellcheck: e.currentTarget.checked })
                            }
                        />{' '}
                        Hide the browser&rsquo;s own spellcheck on checked fields
                    </label>
                </div>
                <div className="gf-options__row">
                    <label>
                        <input
                            type="checkbox"
                            checked={settings.debugLogging}
                            onChange={(e) => void patch({ debugLogging: e.currentTarget.checked })}
                        />{' '}
                        Verbose debug logging (page console)
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
        </>
    )
}
