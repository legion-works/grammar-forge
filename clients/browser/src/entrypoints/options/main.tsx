import { createRoot } from 'react-dom/client'
import { App } from './App'
// Legion Works type stack, bundled — see popup/main.tsx for the rationale
// (this is a separate wxt/vite entry point/bundle, so it needs its own
// imports even though the font FILES are shared/deduped by the bundler).
import '@fontsource/space-grotesk/latin-500.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'
import '@fontsource/geist-sans/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '../popup/popup.css'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
