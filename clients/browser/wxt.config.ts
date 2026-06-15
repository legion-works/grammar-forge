import { defineConfig } from 'wxt'
import { execSync } from 'child_process'

// GrammarForge browser extension (MV3, Chrome + Firefox). Privacy-first: the
// only network target is the user-configured LOCAL bridge. Host access is
// requested on demand via optional_host_permissions, not granted up front.

function getBuildSha(): string {
    try {
        return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    } catch {
        return 'unknown'
    }
}

export default defineConfig({
    srcDir: 'src',
    modules: ['@wxt-dev/module-react'],
    vite: () => ({
        define: {
            // Build-time constants injected into the bundle. The content
            // script logs these at load so the user can verify freshness.
            // GF_BUILD_SHA: short git sha (7 chars). GF_BUILD_TIME: ISO
            // timestamp. Both survive minification (they're string literals
            // after Vite's define substitution).
            __GF_BUILD_SHA__: JSON.stringify(getBuildSha()),
            __GF_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
        },
    }),
    manifest: {
        name: 'GrammarForge',
        description: 'Privacy-first grammar corrections from your self-hosted GrammarForge bridge.',
        permissions: ['storage', 'activeTab'],
        optional_host_permissions: ['<all_urls>'],
        commands: {
            'trigger-check': {
                suggested_key: { default: 'Ctrl+Shift+Period' },
                description: 'Check the focused field now',
            },
        },
    },
})
