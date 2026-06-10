import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('../browser/src', import.meta.url)),
        },
    },
    test: {
        environment: 'jsdom',
    },
})
