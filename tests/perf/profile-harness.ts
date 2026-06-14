// Profile harness wired entry (perf T1). Mounts the three fields and
// — when ?profile is set — installs the console.profile hooks the
// capture.mjs script reads.
//
// Without ?profile, the page is a no-op (just the field fixtures). A
// real profile run requires this script + the WXT dev server + the
// bridge in record mode + a headless Chromium driving
// tests/perf/capture.mjs.

const LOREM_PARAS = [
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
    'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
    'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
    'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.',
]

const params = new URLSearchParams(window.location.search)
const profiling = params.has('profile')

const status = document.getElementById('status')
if (status) {
    status.textContent = profiling
        ? 'profiling — see tests/perf/profiles/baseline/ for captures'
        : 'idle — append ?profile to enable instrumentation'
}

// f1 — textarea
const f1 = document.getElementById('f1') as HTMLTextAreaElement
f1.value = LOREM_PARAS.join('\n\n')

// f2 — contenteditable, 1000 lines
const f2 = document.getElementById('f2') as HTMLElement
const lines: string[] = []
for (let i = 0; i < 1000; i++) lines.push(`<div>line ${i}</div>`)
f2.innerHTML = lines.join('')

// f3 — small streaming fixture
const f3 = document.getElementById('f3') as HTMLElement
f3.textContent = 'short streaming fixture'

// Expose a hook the capture script drives. A real capture run installs
// the GrammarForge content script here; the harness is intentionally
// field-only so the profile captures raw input + flatSegments work
// without the suggestion-attach cost.
declare global {
    interface Window {
        __gfProfile?: {
            fields: { f1: HTMLTextAreaElement; f2: HTMLElement; f3: HTMLElement }
        }
    }
}
window.__gfProfile = { fields: { f1, f2, f3 } }

if (profiling) {
    // Start/stop markers the capture.mjs script reads. Chrome DevTools'
    // performance profiler collects between console.profile('start') and
    // console.profileEnd('start') calls. The capture script triggers
    // each gesture (type / scroll / apply) and reads the captured
    // .cpuprofile from window.__gfProfile.
    // eslint-disable-next-line no-console
    console.profile('gf-harness-init')
    // ... GrammarForge attach would go here in the wired production run.
    // eslint-disable-next-line no-console
    console.profileEnd('gf-harness-init')
}
