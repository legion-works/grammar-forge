import { createRoot } from 'react-dom/client'
import { App } from './App'
// Legion Works type stack, bundled (not CDN — see popup/index.html's removed
// <link> tags): Space Grotesk (display/wordmark), JetBrains Mono (machine
// data, --gf-font-mono — not yet consumed by any popup/options element, but
// bundled for design-token parity with the CDN version this replaces), and
// Geist Sans (UI body text). Only the weights popup.css actually sets
// (400/500/600 for Geist Sans; 500/600/700 for Space Grotesk, matching the
// h1/wordmark's 600 weight plus headroom; 500/600 for JetBrains Mono) are
// imported so the bundler only emits those subsets — latin-only, since the
// UI is English-only. The CSS custom properties in popup.css already fall
// back to system-ui/ui-sans-serif if a font somehow fails to load.
import '@fontsource/space-grotesk/latin-500.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import '@fontsource/geist-sans/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import './popup.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
