export function isLocalBridgeUrl(raw: string): boolean {
    let u: URL
    try {
        u = new URL(raw)
    } catch {
        return false
    }
    // Scheme allowlist: the bridge is an HTTP API. A non-http(s) URL here is
    // misconfiguration at best (fetch would fail anyway) — reject it early so
    // no other code path ever treats e.g. javascript:/file: as "local".
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    let h = u.hostname
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
    if (!m) return false
    const oct: [number, number, number, number] = [
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
    ]
    if (oct.some((o) => o > 255)) return false
    const [a, b] = oct
    if (a === 127) return true
    if (a === 10) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    return false
}
