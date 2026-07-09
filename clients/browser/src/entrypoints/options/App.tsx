// Options/settings page (React). Thin shell that renders the shared SettingsForm
// and the page chrome (header + privacy banner). React is allowed in
// popup/options (NOT in content — see the oxlint `no-restricted-imports`
// override).
import { SettingsForm } from '@/entrypoints/settings/SettingsForm'

export function App() {
    return (
        <main className="gf-options">
            <header className="gf-lockup">
                <img
                    className="gf-lockup__mark"
                    src="/assets/grammarforge-mark.svg"
                    alt=""
                    aria-hidden="true"
                    width={30}
                    height={30}
                />
                <div>
                    <h1 className="gf-lockup__wordmark">
                        <span className="gf-lockup__grammar">Grammar</span>
                        <span className="gf-lockup__forge">Forge</span>
                        <span className="gf-lockup__suffix"> settings</span>
                    </h1>
                    <p className="gf-options__lead">
                        Privacy-first grammar corrections from your self-hosted bridge.
                    </p>
                </div>
            </header>
            <aside className="gf-options__privacy" role="note">
                <strong>Privacy</strong>
                All processing happens on your configured local bridge. No telemetry, no analytics,
                no third-party calls. Settings and your personal dictionary are stored locally in
                this browser only (never synced).
            </aside>
            <SettingsForm />
        </main>
    )
}
