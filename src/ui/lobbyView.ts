// Pure rules behind the lobby page (Lobby.svelte), kept out of the component so they can be tested.
import type { ShareOptions } from '../session/publisher'
import { numParam, sizeParam } from './route'
import { QUALITY_PRESETS, type ShareSettings } from './settings.svelte'

export interface ResolvedShare {
  options: ShareOptions
  /** Auto quality: the session adapts the bitrate to the audience. */
  auto: boolean
  /** Whether the session may add parity when relays allow (auto quality, not a URL override). */
  autoParity: boolean
}

/**
 * The stream options for the saved share settings. With `urlOverrides` (tests/debug:
 * `share=1&source=test&k=…`), the URL's `quality`, `k`, `m`, `bitrate`, `audio` and `mic` replace
 * the settings. `res=WxH` sets the test pattern size either way.
 */
export function resolveShareOptions(sh: ShareSettings, params: URLSearchParams, urlOverrides: boolean): ResolvedShare {
  const preset = QUALITY_PRESETS[sh.quality]
  /** The URL's value under overrides, else the setting's. */
  const pick = <T>(fromUrl: () => T, setting: T): T => (urlOverrides ? fromUrl() : setting)
  const test = sh.source === 'test' || (urlOverrides && params.get('source') === 'test')
  const auto = pick(() => params.get('quality') === 'auto', sh.quality === 'auto')
  return {
    options: {
      k: Math.max(1, pick(() => numParam(params, 'k', sh.k), sh.k)),
      m: Math.max(0, pick(() => numParam(params, 'm', sh.m), sh.m)),
      bitrateKbps: pick(() => numParam(params, 'bitrate', preset.kbps), preset.kbps),
      source: test ? 'test' : 'screen',
      surface: sh.source === 'window' ? 'window' : sh.source === 'tab' ? 'browser' : 'monitor',
      maxSize: [preset.maxWidth, preset.maxHeight],
      audio: pick(() => params.get('audio') === '1', sh.systemAudio),
      mic: pick(() => params.get('mic') === '1', sh.mic),
      testSize: sizeParam(params, 'res'),
    },
    auto,
    autoParity: auto && !urlOverrides,
  }
}

/** The part of the session that auto quality drives. */
export interface AutoQualityTarget {
  autoBitrate: boolean
  autoParity(k: number, m: number, bitrateKbps: number): number
}

/** Switches the session's auto bitrate to match, and lets it add parity: the options to share with. */
export function applyAutoQuality(r: ResolvedShare, session: AutoQualityTarget | null): ShareOptions {
  if (!session) return r.options
  session.autoBitrate = r.auto
  if (!r.autoParity) return r.options
  const { k, m, bitrateKbps } = r.options
  return { ...r.options, m: session.autoParity(k, m, bitrateKbps) }
}

export interface StageState {
  /** Linked into the lobby mesh. */
  joined: boolean
  trackers: number
  /** This peer is presenting (its own stream is on stage). */
  presenting: boolean
  /** Whether the presenter's own preview may show (the tab is focused, or a test pattern). */
  showOwnPreview: boolean
  /** The publisher on stage, if any, and whether its stream has decoded a frame yet. */
  stage: { name: string; decoding: boolean } | null
  shareError: string | null
  canShare: boolean
  ownerAway: boolean
}

/** The message shown over the stage, in order of precedence; null when the stream shows. */
export function stageMessage(s: StageState): string | null {
  if (s.presenting && !s.showOwnPreview) {
    return 'You are presenting to the lobby. The preview is hidden while this tab isn’t focused.'
  }
  if (!s.joined) return `Looking for the lobby… (${s.trackers} trackers connected)`
  if (s.presenting) return null
  if (!s.stage) {
    if (s.shareError) return `Couldn't start sharing: ${s.shareError}`
    if (s.canShare) return 'Click Share screen to present to the lobby.'
    return s.ownerAway ? 'The owner is away. Nobody is sharing.' : 'Nobody is sharing yet.'
  }
  return s.stage.decoding ? null : `Connecting to ${s.stage.name}'s stream…`
}
