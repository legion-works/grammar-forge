// Options/settings page (React). Thin shell that renders the shared SettingsForm
// and the page chrome (header + privacy banner). React is allowed in
// popup/options (NOT in content — see the oxlint `no-restricted-imports`
// override).
import { SettingsForm } from '@/entrypoints/settings/SettingsForm'

export function App() {
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
            <SettingsForm />
        </main>
    )
}
