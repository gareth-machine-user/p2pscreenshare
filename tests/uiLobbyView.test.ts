/// <reference types="svelte" />
/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app types these src/ui modules use: runes, import.meta.env.)
import { describe, expect, it } from 'vitest'
import { applyAutoQuality, connectionWord, lobbyPeople, peerBadges, playbackReadout, resolveShareOptions, stageMessage, startErrorText, type StageState } from '../src/ui/lobbyView'
import { DEFAULT_SETTINGS, STRIPE_LIMITS, type ShareSettings } from '../src/ui/settings.svelte'
import { maxSizeFor, targetKbps, type VideoQuality } from '../src/media/quality'

const share = (over: Partial<ShareSettings> = {}): ShareSettings => ({ ...DEFAULT_SETTINGS.share, ...over })
const q = (s: string) => new URLSearchParams(s)

describe('resolveShareOptions', () => {
  it('uses the settings without URL overrides', () => {
    const video: VideoQuality = { resolution: '1440', fps: 60, level: 'high', customKbps: null }
    const r = resolveShareOptions(
      share({ video, autoLower: false, k: 3, m: 2, systemAudio: false, mic: true, source: 'tab' }),
      q('k=9&m=0&audio=1&quality=auto&fps=30'),
      false,
    )
    expect(r.options).toEqual({
      k: 3,
      m: 2,
      bitrateKbps: targetKbps(video),
      fps: 60,
      source: 'screen',
      surface: 'browser',
      maxSize: maxSizeFor('1440'),
      audio: false,
      mic: true,
      testSize: undefined,
    })
    expect(r.auto).toBe(false)
  })

  it('auto quality from the settings keeps the chosen stripes', () => {
    const r = resolveShareOptions(share({ autoLower: true, k: 4, m: 2 }), q(''), false)
    expect(r.auto).toBe(true)
    expect(r.options).toMatchObject({ k: 4, m: 2 })
  })

  it('takes the URL values under overrides, falling back to the settings for bad numbers', () => {
    const r = resolveShareOptions(share({ k: 4, m: 1 }), q('source=test&k=2&m=x&bitrate=1234&fps=60&audio=1&mic=0&quality=auto&res=640x360'), true)
    expect(r.options).toMatchObject({ k: 2, m: 1, bitrateKbps: 1234, fps: 60, source: 'test', audio: true, mic: false, testSize: [640, 360] })
    expect(r.auto).toBe(true)
  })

  it('URL overrides without quality=auto turn auto off and default audio off', () => {
    const r = resolveShareOptions(share({ autoLower: true, systemAudio: true }), q('share=1'), true)
    expect(r.auto).toBe(false)
    expect(r.options.audio).toBe(false)
    expect(r.options.bitrateKbps).toBe(targetKbps(DEFAULT_SETTINGS.share.video))
    expect(r.options.fps).toBe(30)
  })

  it('a Native resolution takes its bitrate from the screen size', () => {
    const video: VideoQuality = { resolution: 'native', fps: 30, level: 'standard', customKbps: null }
    const at = (size: [number, number]) => resolveShareOptions(share({ video }), q(''), false, size).options.bitrateKbps
    expect(at([3840, 2160])).toBeGreaterThan(at([1920, 1080]))
  })

  it('clamps URL stripe counts to the settings bounds, as integers', () => {
    const opts = (query: string) => resolveShareOptions(share(), q(query), true).options
    expect(opts('k=2.6&m=1.4')).toMatchObject({ k: 3, m: 1 })
    expect(opts('k=300&m=100')).toMatchObject({ k: STRIPE_LIMITS.k.max, m: STRIPE_LIMITS.m.max })
    expect(opts('k=0.2&m=-0.4')).toMatchObject({ k: 1, m: 0 })
  })

  it('clamps k and m to their minimums', () => {
    const r = resolveShareOptions(share(), q('k=0&m=-3'), true)
    expect(r.options.k).toBe(1)
    expect(r.options.m).toBe(0)
  })

  it('maps the source setting to the picker surface', () => {
    expect(resolveShareOptions(share({ source: 'window' }), q(''), false).options.surface).toBe('window')
    expect(resolveShareOptions(share({ source: 'screen' }), q(''), false).options.surface).toBe('monitor')
    expect(resolveShareOptions(share({ source: 'test' }), q(''), false).options.source).toBe('test')
  })

  it('shares a camera with the saved facing, and takes a camera from the URL under overrides', () => {
    expect(resolveShareOptions(share({ source: 'camera', facing: 'environment' }), q(''), false).options).toMatchObject({ source: 'camera', facing: 'environment' })
    expect(resolveShareOptions(share({ source: 'camera', facing: 'environment' }), q('share=1'), true).options).toMatchObject({ source: 'camera', facing: 'environment' })
    expect(resolveShareOptions(share(), q('source=camera&facing=environment'), true).options).toMatchObject({ source: 'camera', facing: 'environment' })
    expect(resolveShareOptions(share({ facing: 'environment' }), q('source=camera'), true).options).toMatchObject({ source: 'camera', facing: 'user' })
    // A URL test pattern wins over a saved camera.
    expect(resolveShareOptions(share({ source: 'camera' }), q('source=test'), true).options.source).toBe('test')
    expect(resolveShareOptions(share({ source: 'screen' }), q(''), false).options.facing).toBeUndefined()
  })
})

describe('applyAutoQuality', () => {
  it('sets auto bitrate and shares with the resolved options', () => {
    const t = { autoBitrate: false }
    const r = resolveShareOptions(share({ autoLower: true, m: 1 }), q(''), false)
    expect(applyAutoQuality(r, t)).toBe(r.options)
    expect(t.autoBitrate).toBe(true)
  })

  it('clears auto bitrate when not auto', () => {
    const t = { autoBitrate: true }
    const r = resolveShareOptions(share({ autoLower: false, m: 1 }), q(''), false)
    expect(applyAutoQuality(r, t).m).toBe(1)
    expect(t.autoBitrate).toBe(false)
  })

  it('returns the options as is without a session', () => {
    const r = resolveShareOptions(share({ autoLower: true }), q(''), false)
    expect(applyAutoQuality(r, null)).toBe(r.options)
  })
})

describe('stageMessage', () => {
  const base: StageState = {
    joined: true,
    trackers: 2,
    presenting: false,
    showOwnPreview: true,
    stage: null,
    shareError: null,
    canShare: false,
    ownerAway: false,
  }

  it('follows the precedence of the stage states', () => {
    expect(stageMessage({ ...base, joined: false })).toBe('Looking for the lobby… (2 trackers connected)')
    expect(stageMessage({ ...base, joined: false, presenting: true, showOwnPreview: false })).toMatch(/^You are presenting/)
    expect(stageMessage({ ...base, presenting: true })).toBeNull()
    expect(stageMessage({ ...base, shareError: 'denied', canShare: true })).toBe("Couldn't start sharing: denied")
    expect(stageMessage({ ...base, canShare: true, ownerAway: true })).toBe('Click Share screen to present to the lobby.')
    expect(stageMessage({ ...base, canShare: true, cameraOnly: true })).toBe('Tap Share camera to present to the lobby.')
    expect(stageMessage({ ...base, ownerAway: true })).toBe('The owner is away. Nobody is sharing.')
    expect(stageMessage(base)).toBe('Nobody is sharing yet.')
    expect(stageMessage({ ...base, stage: { name: 'ann', decoding: false } })).toBe("Connecting to ann's stream…")
    expect(stageMessage({ ...base, stage: { name: 'ann', decoding: true }, shareError: 'x' })).toBeNull()
  })
})

describe('connectionWord', () => {
  it('names the link state, then grades an open link by its round trip', () => {
    expect(connectionWord('connecting', null)).toMatchObject({ text: 'Connecting…', warn: false })
    expect(connectionWord('unreachable', null)).toMatchObject({ text: "Can't connect", warn: true })
    expect(connectionWord('none', null)).toMatchObject({ text: 'No link', warn: true })
    expect(connectionWord('open', null)).toMatchObject({ text: 'Connected', warn: false })
    expect(connectionWord('open', 40)).toMatchObject({ text: 'Good', warn: false, title: 'Direct connection, 40 ms round trip' })
    expect(connectionWord('open', 200)).toMatchObject({ text: 'OK', warn: false })
    expect(connectionWord('open', 500)).toMatchObject({ text: 'Slow', warn: true })
  })
})

describe('playbackReadout', () => {
  const p = { latencyMs: 84, fps: 29.6, height: 1080, decodedFrames: 1000, droppedFrames: 0 }
  it('is null until a frame decodes', () => {
    expect(playbackReadout(null)).toBeNull()
    expect(playbackReadout({ ...p, decodedFrames: 0 })).toBeNull()
  })
  it('shows size, frame rate and delay, graded by delay and drops', () => {
    expect(playbackReadout(p)).toMatchObject({ text: '1080p30 · 84 ms', level: 'good' })
    expect(playbackReadout({ ...p, latencyMs: null })?.text).toBe('1080p30')
    expect(playbackReadout({ ...p, latencyMs: 900 })?.level).toBe('ok')
    expect(playbackReadout({ ...p, droppedFrames: 50 })?.level).toBe('ok')
    expect(playbackReadout({ ...p, latencyMs: 2000 })?.level).toBe('poor')
    expect(playbackReadout({ ...p, droppedFrames: 200 })?.level).toBe('poor')
  })
})

describe('startErrorText', () => {
  it('gives the HTTPS / browser advice only when WebCrypto is missing', () => {
    expect(startErrorText(new TypeError("Cannot read properties of undefined (reading 'deriveBits')"), false)).toMatch(/HTTPS/)
    expect(startErrorText(new DOMException('Unrecognized name.', 'NotSupportedError'), true)).toMatch(/HTTPS/)
  })

  it('names any other failure as it is', () => {
    const text = startErrorText(new Error('tracker exploded'), true)
    expect(text).toBe("Couldn't start the lobby: tracker exploded")
    expect(startErrorText('boom', true)).toBe("Couldn't start the lobby: boom")
  })
})

describe('lobbyPeople', () => {
  const rec = (id: string, name = id, rtt: Record<string, number> = {}) => ({ id, name, rtt })
  const base = {
    ownerId: 'owner',
    presenters: new Set<string>(),
    asking: new Set<string>(),
    linkStatus: () => 'open' as const,
  }

  it('lists you first, then the owner, presenters and the rest, in member order', () => {
    const people = lobbyPeople({
      ...base,
      self: rec('me'),
      members: [rec('a'), rec('b'), rec('owner'), rec('c')],
      presenters: new Set(['c', 'me']),
    })
    expect(people.map((p) => p.id)).toEqual(['me', 'owner', 'c', 'a', 'b'])
    expect(people.map((p) => p.badges)).toEqual([['presenting'], ['owner'], ['presenting'], [], []])
  })

  it('ranks the owner first among others even when it presents', () => {
    const people = lobbyPeople({ ...base, self: rec('me'), members: [rec('c'), rec('owner')], presenters: new Set(['owner', 'c']) })
    expect(people.map((p) => p.id)).toEqual(['me', 'owner', 'c'])
    expect(people[1].badges).toEqual(['owner', 'presenting'])
  })

  it('names unnamed peers by their id, flags requests and has no connection for you', () => {
    const people = lobbyPeople({ ...base, self: rec('me-123456789', ''), members: [rec('abcdefgh', '')], asking: new Set(['abcdefgh']) })
    expect(people[0]).toMatchObject({ name: 'me-123', self: true, conn: null, asking: false })
    expect(people[1]).toMatchObject({ name: 'abcdef', self: false, asking: true })
  })

  it('uses our RTT to a peer, else theirs to us', () => {
    const people = lobbyPeople({
      ...base,
      self: rec('me', 'me', { a: 500 }),
      members: [rec('a', 'a', { me: 50 }), rec('b', 'b', { me: 50 }), rec('c')],
      linkStatus: (id) => (id === 'c' ? 'unreachable' : 'open'),
    })
    expect(people.slice(1).map((p) => p.conn)).toEqual([connectionWord('open', 500), connectionWord('open', 50), connectionWord('unreachable', null)])
  })
})

describe('peerBadges', () => {
  it('marks the owner and presenters', () => {
    expect(peerBadges('o', 'o', new Set(['o']))).toEqual(['owner', 'presenting'])
    expect(peerBadges('x', null, new Set())).toEqual([])
  })
})
