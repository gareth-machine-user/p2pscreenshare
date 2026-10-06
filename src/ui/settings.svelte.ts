// User settings, persisted in localStorage. Reads and writes are wrapped so the app still works
// when storage is unavailable (private windows, blocked site data).

export type SourceKind = 'screen' | 'window' | 'tab' | 'test'
export type QualityPreset = 'auto' | '4k' | '2k' | '1080p-ultra' | '1080p-hi' | '1080p' | '720p' | 'low'
export type ViewQuality = 'auto' | 'full' | 'preview'

export interface ShareSettings {
  source: SourceKind
  /** Share system or tab audio, when the browser offers it. */
  systemAudio: boolean
  /** Mix in the microphone. */
  mic: boolean
  quality: QualityPreset
  /** Advanced: data and parity stripes. */
  k: number
  m: number
}

export interface Settings {
  name: string
  share: ShareSettings
  view: { quality: ViewQuality; chatOpen: boolean }
}

const KEY = 'p2pss:settings'

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  share: { source: 'screen', systemAudio: true, mic: false, quality: 'auto', k: 4, m: 1 },
  view: { quality: 'auto', chatOpen: true },
}

/** Bitrate and capture size for each quality preset. */
export const QUALITY_PRESETS: Record<QualityPreset, { label: string; kbps: number; maxWidth: number; maxHeight: number }> = {
  auto: { label: 'Auto', kbps: 2500, maxWidth: 1920, maxHeight: 1080 },
  '4k': { label: '4K (2160p)', kbps: 20000, maxWidth: 3840, maxHeight: 2160 },
  '2k': { label: '2K (1440p)', kbps: 12000, maxWidth: 2560, maxHeight: 1440 },
  '1080p-ultra': { label: '1080p Ultra-Hi', kbps: 16000, maxWidth: 1920, maxHeight: 1080 },
  '1080p-hi': { label: '1080p High', kbps: 8000, maxWidth: 1920, maxHeight: 1080 },
  '1080p': { label: '1080p', kbps: 4500, maxWidth: 1920, maxHeight: 1080 },
  '720p': { label: '720p', kbps: 2500, maxWidth: 1280, maxHeight: 720 },
  low: { label: 'Low', kbps: 900, maxWidth: 960, maxHeight: 540 },
};
export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: settings last for this page only
  }
}

const SOURCES: readonly SourceKind[] = ['screen', 'window', 'tab', 'test']
const VIEW_QUALITIES: readonly ViewQuality[] = ['auto', 'full', 'preview']

/** `v` if it is one of `allowed`, else `fallback`. */
function oneOf<T>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * Settings from their stored JSON. Each field is checked and falls back to its default on its own,
 * so a stale or corrupted value (an old quality preset, a bad type) can't break the share dialog.
 */
export function parseSettings(raw: string | null): Settings {
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // corrupted: defaults
  }
  const s = obj(parsed)
  const share = obj(s.share)
  const view = obj(s.view)
  const d = DEFAULT_SETTINGS
  return {
    name: typeof s.name === 'string' ? s.name : d.name,
    share: {
      source: oneOf(share.source, SOURCES, d.share.source),
      systemAudio: bool(share.systemAudio, d.share.systemAudio),
      mic: bool(share.mic, d.share.mic),
      quality: Object.hasOwn(QUALITY_PRESETS, share.quality as string) ? (share.quality as QualityPreset) : d.share.quality,
      k: int(share.k, 1, 16, d.share.k),
      m: int(share.m, 0, 8, d.share.m),
    },
    view: {
      quality: oneOf(view.quality, VIEW_QUALITIES, d.view.quality),
      chatOpen: bool(view.chatOpen, d.view.chatOpen),
    },
  }
}

export const settings: Settings = $state(parseSettings(storageGet(KEY)))

export function saveSettings(): void {
  storageSet(KEY, JSON.stringify($state.snapshot(settings)))
}

/** The owner's private seed for a lobby, kept on the device that created it. */
export function ownerSeed(joinCode: string): string | null {
  return storageGet(`p2pss:owner:${joinCode}`)
}

export function rememberOwnerSeed(joinCode: string, seed: string): void {
  storageSet(`p2pss:owner:${joinCode}`, seed)
}
