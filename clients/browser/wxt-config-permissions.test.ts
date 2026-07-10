// Regression guard: wxt.config.ts's comment ("Host access is requested on
// demand via optional_host_permissions, not granted up front") is a
// privacy/security invariant, not just documentation — an MV3 manifest
// with install-time `host_permissions: ['<all_urls>']` would prompt the
// user for blanket host access at install, instead of the current
// on-demand `optional_host_permissions` flow (browser.permissions.request
// at first-use). This test reads wxt.config.ts AS TEXT (not by importing
// it — the config also runs `execSync('git rev-parse ...')` inside a Vite
// `define` factory, which we don't need to invoke to check this) so a
// future edit that silently moves `<all_urls>` (or any host pattern) from
// `optional_host_permissions` into an install-time `host_permissions` key
// fails CI instead of shipping quietly.
//
// Lives at the project ROOT (not under src/lib) deliberately: clients/vencord's
// tsconfig.json blanket-includes `../browser/src/lib/**/*` (to share
// legion-tokens.ts etc.) but has no `@types/node` — a src/lib test file
// importing `node:fs`/`node:url` would fail vencord's `tsc --noEmit`. This
// file sits next to the wxt.config.ts it tests, outside every glob any
// other client's tsconfig reaches into.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const WXT_CONFIG_PATH = fileURLToPath(new URL('./wxt.config.ts', import.meta.url))
const source = readFileSync(WXT_CONFIG_PATH, 'utf8')

describe('wxt.config.ts must not declare install-time host_permissions', () => {
    it('has no `host_permissions` key (only `optional_host_permissions`)', () => {
        // \b fails to match between the "_" of "optional_" and the "h" of
        // "host_permissions" (both word characters — no boundary there),
        // so this only matches a STANDALONE `host_permissions` key, never
        // as a suffix of `optional_host_permissions`.
        expect(source).not.toMatch(/\bhost_permissions\s*:/)
    })

    it('declares `optional_host_permissions: [\'<all_urls>\']`', () => {
        expect(source).toMatch(/optional_host_permissions\s*:\s*\[\s*['"]<all_urls>['"]\s*\]/)
    })
})
