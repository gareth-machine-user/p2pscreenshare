export type Route =
  | { page: 'home' }
  | { page: 'host'; params: URLSearchParams }
  | { page: 'watch'; streamId: string; params: URLSearchParams }

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#/, '').split('?')
  const params = new URLSearchParams(query)
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === 'host') return { page: 'host', params }
  if (parts[0] === 'watch' && parts[1]) return { page: 'watch', streamId: decodeURIComponent(parts[1]), params }
  return { page: 'home' }
}

/** Tracker URLs: ?tracker=ws://a,wss://b (page query or hash query) or VITE_TRACKERS; else Trystero defaults. */
export function trackersFrom(params: URLSearchParams): string[] | undefined {
  const raw =
    params.get('tracker') ??
    new URLSearchParams(location.search).get('tracker') ??
    (import.meta.env.VITE_TRACKERS as string | undefined)
  const list = raw
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list?.length ? list : undefined
}

export function numParam(params: URLSearchParams, key: string, fallback: number): number {
  const v = params.get(key)
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function randomId(len = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export function fmtKbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—'
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} kbps`
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return `${Math.round(ms)} ms`
}

/** ICE servers: ?ice=none (LAN/tests), ?ice=stun:host:port,turn:... or the default public STUN. */
export function iceFrom(params: URLSearchParams): RTCIceServer[] | undefined {
  const raw = params.get('ice') ?? new URLSearchParams(location.search).get('ice')
  if (raw === null) return undefined
  if (raw === 'none') return []
  return raw
    .split(',')
    .filter(Boolean)
    .map((urls) => ({ urls }))
}
