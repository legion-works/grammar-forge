// Regression guard: only loopback bridge access is granted at install time;
// arbitrary hosts stay behind the on-demand optional permission. Read the
// config as text because importing it also executes its build metadata factory.
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

describe('wxt.config.ts host permissions', () => {
    it('grants only the loopback hosts at install time', () => {
        expect(source).toMatch(
            /\bhost_permissions\s*:\s*\[\s*['"]http:\/\/localhost\/\*['"]\s*,\s*['"]http:\/\/127\.0\.0\.1\/\*['"]\s*\]/,
        )
    })

    it("declares `optional_host_permissions: ['<all_urls>']`", () => {
        expect(source).toMatch(/optional_host_permissions\s*:\s*\[\s*['"]<all_urls>['"]\s*\]/)
    })
})
