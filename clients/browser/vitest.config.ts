import { WxtVitest } from 'wxt/testing'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    plugins: [WxtVitest()],
    test: {
        // Default to node; per-file `// @vitest-environment jsdom` opts DOM tests in.
        environment: 'node',
    },
})
