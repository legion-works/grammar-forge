import { defineConfig } from 'wxt'

// GrammarForge browser extension (MV3, Chrome + Firefox). Privacy-first: the
// only network target is the user-configured LOCAL bridge. Host access is
// requested on demand via optional_host_permissions, not granted up front.
export default defineConfig({
    srcDir: 'src',
    modules: ['@wxt-dev/module-react'],
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
