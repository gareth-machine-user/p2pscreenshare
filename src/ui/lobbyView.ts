// Pure rules behind the lobby page (Lobby.svelte), kept out of the component so they can be tested.
import type { TestPatternKind } from '../media/capture'
import type { ShareOptions } from '../session/publishedStream'
import { numParam, sizeParam } from './route'
import { maxSizeFor, targetKbps } from '../media/quality'
import type { ShareSettings } from './settings.svelte'

export interface ResolvedShare {
  options: ShareOptions
  /** Auto quality: the session adapts the bitrate to the audience. */
  auto: boolean
  /** Whether the session may add parity when relays allow (auto quality, not a URL override). */
  autoParity: boolean
}

/**
 * The stream options for the saved share settings. With `urlOverrides` (tests/debug:
 * `share=1&source=test&k=…`, or `source=camera&facing=…`), the URL's `quality=auto` (lower
 * automatically), `k`, `m`, `bitrate`, `fps`, `audio` and `mic` replace the settings. `res=WxH`
 * sets the test pattern size either way, `pattern=busy|bursty` its high-entropy variants.
 * `nativeSize` is the screen in device pixels, for the bitrate of the Native resolution.
 */
export function resolveShareOptions(sh: ShareSettings, params: URLSearchParams, urlOverrides: boolean, nativeSize?: [number, number]): ResolvedShare {
  const kbps = targetKbps(sh.video, nativeSize)
  /** The URL's value under overrides, else the setting's. */
  const pick = <T>(fromUrl: () => T, setting: T): T => (urlOverrides ? fromUrl() : setting)
  const fromUrl = urlOverrides ? params.get('source') : null
  const test = sh.source === 'test' || fromUrl === 'test'
  const camera = !test && (fromUrl === 'camera' || (fromUrl === null && sh.source === 'camera'))
  const auto = pick(() => params.get('quality') === 'auto', sh.autoLower)
  return {
    options: {
      k: Math.max(1, pick(() => numParam(params, 'k', sh.k), sh.k)),
      m: Math.max(0, pick(() => numParam(params, 'm', sh.m), sh.m)),
      bitrateKbps: pick(() => numParam(params, 'bitrate', kbps), kbps),
      fps: pick(() => numParam(params, 'fps', sh.video.fps), sh.video.fps),
      source: test ? 'test' : camera ? 'camera' : 'screen',
      ...(camera ? { facing: fromUrl === 'camera' ? (params.get('facing') === 'environment' ? 'environment' : 'user') : sh.facing } : {}),
      surface: sh.source === 'window' ? 'window' : sh.source === 'tab' ? 'browser' : 'monitor',
      maxSize: maxSizeFor(sh.video.resolution),
      audio: pick(() => params.get('audio') === '1', sh.systemAudio),
      mic: pick(() => params.get('mic') === '1', sh.mic),
      testSize: sizeParam(params, 'res'),
      testPattern: oneOfPattern(params.get('pattern')),
    },
    auto,
    autoParity: auto && !urlOverrides,
  }
}

function oneOfPattern(p: string | null): TestPatternKind | undefined {
  return p === 'busy' || p === 'bursty' ? p : undefined
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
  /** This device shares a camera (it can't capture its screen). */
  cameraOnly?: boolean
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
    if (s.canShare) return s.cameraOnly ? 'Tap Share camera to present to the lobby.' : 'Click Share screen to present to the lobby.'
    return s.ownerAway ? 'The owner is away. Nobody is sharing.' : 'Nobody is sharing yet.'
  }
  return s.stage.decoding ? null : `Connecting to ${s.stage.name}'s stream…`
}
