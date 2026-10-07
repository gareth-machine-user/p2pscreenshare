/// <reference types="svelte" />
/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app types these src/ui modules use: runes, import.meta.env.)
import { describe, expect, it } from 'vitest'
import { applyAutoQuality, resolveShareOptions, stageMessage, type StageState } from '../src/ui/lobbyView'
import { DEFAULT_SETTINGS, type ShareSettings } from '../src/ui/settings.svelte'
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
    expect(r.autoParity).toBe(false)
  })

  it('auto quality from the settings may add parity', () => {
    const r = resolveShareOptions(share({ autoLower: true }), q(''), false)
    expect(r.auto).toBe(true)
    expect(r.autoParity).toBe(true)
  })

  it('takes the URL values under overrides, falling back to the settings for bad numbers', () => {
    const r = resolveShareOptions(share({ k: 4, m: 1 }), q('source=test&k=2&m=x&bitrate=1234&fps=60&audio=1&mic=0&quality=auto&res=640x360'), true)
    expect(r.options).toMatchObject({ k: 2, m: 1, bitrateKbps: 1234, fps: 60, source: 'test', audio: true, mic: false, testSize: [640, 360] })
    expect(r.auto).toBe(true)
    // URL overrides pin the parity.
    expect(r.autoParity).toBe(false)
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
  const target = () => ({ autoBitrate: false, autoParity: (_k: number, m: number) => m + 1 })

  it('sets auto bitrate and lets the session pick parity', () => {
    const t = target()
    const r = resolveShareOptions(share({ autoLower: true, m: 1 }), q(''), false)
    expect(applyAutoQuality(r, t).m).toBe(2)
    expect(t.autoBitrate).toBe(true)
    // The resolved options are left alone.
    expect(r.options.m).toBe(1)
  })

  it('keeps the parity when not auto, and clears auto bitrate', () => {
    const t = { ...target(), autoBitrate: true }
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
