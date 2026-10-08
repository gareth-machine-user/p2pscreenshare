// Pure rules behind the lobby page (Lobby.svelte), kept out of the component so they can be tested.
import type { TestPatternKind } from '../media/capture'
import type { ShareOptions } from '../session/publishedStream'
import type { MemberRecord } from '../mesh/records'
import { numParam, sizeParam } from './route'
import { maxSizeFor, targetKbps } from '../media/quality'
import { STRIPE_LIMITS, type ShareSettings } from './settings.svelte'

export interface ResolvedShare {
  options: ShareOptions
  /** Auto quality: the session adapts the bitrate to the audience. */
  auto: boolean
}

/**
 * The stream options for the saved share settings. With `urlOverrides` (tests/debug:
 * `share=1&source=test&k=…`, or `source=camera&facing=…`), the URL's `quality=auto` (lower
 * automatically), `k`, `m`, `bitrate`, `fps`, `audio` and `mic` replace the settings. `res=WxH`
 * sets the test pattern size either way, `pattern=busy|bursty` its high-entropy variants.
 * `nativeSize` is the screen in device pixels, for the bitrate of the Native resolution.
 */
/** A stripe count within its settings' bounds, as an integer (the wire format and the FEC need one). */
function stripeCount(n: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, Math.round(n)))
}

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
      k: stripeCount(pick(() => numParam(params, 'k', sh.k), sh.k), STRIPE_LIMITS.k),
      m: stripeCount(pick(() => numParam(params, 'm', sh.m), sh.m), STRIPE_LIMITS.m),
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
  }
}

function oneOfPattern(p: string | null): TestPatternKind | undefined {
  return p === 'busy' || p === 'bursty' ? p : undefined
}

/** The part of the session that auto quality drives. */
export interface AutoQualityTarget {
  autoBitrate: boolean
}

/** Switches the session's auto bitrate to match: the options to share with. */
export function applyAutoQuality(r: ResolvedShare, session: AutoQualityTarget | null): ShareOptions {
  if (session) session.autoBitrate = r.auto
  return r.options
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

/**
 * A member's connection in a word or two, for the People list: from the mesh link's state and
 * its round-trip time. Warns when it is slow or missing.
 */
export function connectionWord(
  status: 'open' | 'connecting' | 'unreachable' | 'none',
  rttMs: number | null,
): { text: string; title: string; warn: boolean } {
  if (status === 'connecting') return { text: 'Connecting…', title: 'Setting up a direct connection', warn: false }
  if (status === 'unreachable') return { text: "Can't connect", title: 'No direct connection: the stream reaches them through others', warn: true }
  if (status === 'none') return { text: 'No link', title: 'No direct connection yet', warn: true }
  if (rttMs === null) return { text: 'Connected', title: 'Direct connection', warn: false }
  const title = `Direct connection, ${Math.round(rttMs)} ms round trip`
  if (rttMs < 150) return { text: 'Good', title, warn: false }
  if (rttMs < 400) return { text: 'OK', title, warn: false }
  return { text: 'Slow', title, warn: true }
}

/** A member's badges (chat, the People list, the Peers tab). */
export function peerBadges(id: string, ownerId: string | null, presenters: ReadonlySet<string>): string[] {
  const out: string[] = []
  if (id === ownerId) out.push('owner')
  if (presenters.has(id)) out.push('presenting')
  return out
}

/** A row of the People list. */
export interface Person {
  id: string
  name: string
  self: boolean
  badges: string[]
  /** Waiting for the owner to let them share. */
  asking: boolean
  /** Their connection, in a word or two; warn when it's poor or missing. */
  conn: { text: string; title: string; warn: boolean } | null
}

type PersonRecord = Pick<MemberRecord, 'id' | 'name' | 'rtt'>

/** Everyone in the lobby for the People tab: you first, then the owner, presenters and the rest. */
export function lobbyPeople(p: {
  self: PersonRecord
  members: PersonRecord[]
  ownerId: string | null
  /** Who is presenting. */
  presenters: ReadonlySet<string>
  /** Who is asking to share. */
  asking: { has(id: string): boolean }
  linkStatus: (id: string) => Parameters<typeof connectionWord>[0]
}): Person[] {
  const selfId = p.self.id
  const rank = (id: string) => (id === selfId ? 0 : id === p.ownerId ? 1 : p.presenters.has(id) ? 2 : 3)
  return [p.self, ...p.members]
    .map((r) => {
      const self = r.id === selfId
      return {
        id: r.id,
        name: r.name || r.id.slice(0, 6),
        self,
        badges: peerBadges(r.id, p.ownerId, p.presenters),
        asking: p.asking.has(r.id),
        // Our measured RTT to them, else theirs to us.
        conn: self ? null : connectionWord(p.linkStatus(r.id), p.self.rtt[r.id] ?? r.rtt[selfId] ?? null),
      }
    })
    .sort((a, b) => rank(a.id) - rank(b.id))
}

/** The viewer's one-line playback readout ("1080p30 · 84 ms"), or null until frames decode. */
export function playbackReadout(
  p: { latencyMs: number | null; fps: number; height: number; decodedFrames: number; droppedFrames: number } | null,
): { text: string; title: string; level: 'good' | 'ok' | 'poor' } | null {
  if (!p || p.decodedFrames === 0 || !p.height) return null
  const parts = [`${p.height}p${Math.round(p.fps)}`]
  if (p.latencyMs !== null) parts.push(`${Math.round(p.latencyMs)} ms`)
  const dropped = p.droppedFrames / Math.max(1, p.decodedFrames + p.droppedFrames)
  const latency = p.latencyMs ?? 0
  const level = latency > 1500 || dropped > 0.1 ? 'poor' : latency > 600 || dropped > 0.02 ? 'ok' : 'good'
  return { text: parts.join(' · '), title: 'Resolution and frame rate, and the delay from the presenter’s screen to yours', level }
}

/**
 * Why the lobby (or a new one) couldn't start, for the page. Only a missing WebCrypto (an insecure
 * origin has no `crypto.subtle`; older browsers lack Ed25519) gets the HTTPS / browser advice.
 */
export function startErrorText(e: unknown, hasSubtle = !!globalThis.crypto?.subtle): string {
  const notSupported = !hasSubtle || (e instanceof Error && e.name === 'NotSupportedError')
  if (notSupported) return "This browser can't create the lobby's keys. Open the page over HTTPS, in an up-to-date browser."
  return `Couldn't start the lobby: ${e instanceof Error ? e.message : String(e)}`
}
