// User settings, persisted in localStorage. Reads and writes are wrapped so the app still works
// when storage is unavailable (private windows, blocked site data).

export type SourceKind = 'screen' | 'window' | 'tab' | 'test'
export type QualityPreset = 'auto' | '1080p' | '720p' | 'low'
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
  '1080p': { label: '1080p', kbps: 4500, maxWidth: 1920, maxHeight: 1080 },
  '720p': { label: '720p', kbps: 2500, maxWidth: 1280, maxHeight: 720 },
  low: { label: 'Low', kbps: 900, maxWidth: 960, maxHeight: 540 },
}

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

function load(): Settings {
  const raw = storageGet(KEY)
  if (!raw) return structuredClone(DEFAULT_SETTINGS)
  try {
    const s = JSON.parse(raw) as Partial<Settings>
    return {
      name: typeof s.name === 'string' ? s.name : '',
      share: { ...DEFAULT_SETTINGS.share, ...s.share },
      view: { ...DEFAULT_SETTINGS.view, ...s.view },
    }
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export const settings: Settings = $state(load())

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
