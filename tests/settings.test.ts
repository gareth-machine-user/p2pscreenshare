/// <reference types="svelte" />
/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app types these src/ui modules use: runes, import.meta.env.)
import { describe, expect, it } from 'vitest'
import { clampStripes, DEFAULT_SETTINGS, parseSettings, STRIPE_LIMITS, supportedSource } from '../src/ui/settings.svelte'
import { CUSTOM_KBPS } from '../src/media/quality'

describe('parseSettings', () => {
  it('returns the defaults when nothing is stored or the JSON is corrupted', () => {
    for (const raw of [null, '', '{not json', 'null', '42', '"str"', '[]']) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('does not share objects with the defaults', () => {
    const s = parseSettings(null)
    s.share.k = 9
    expect(DEFAULT_SETTINGS.share.k).toBe(4)
  })

  it('keeps valid stored values', () => {
    const stored = {
      name: 'Ann',
      share: {
        source: 'tab',
        facing: 'environment',
        systemAudio: false,
        mic: true,
        video: { resolution: '1440', fps: 60, level: 'very-high', customKbps: null },
        autoLower: false,
        k: 6,
        m: 0,
      },
      view: { quality: 'preview', buffering: 'extra', chatOpen: false },
    }
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored)
    // A custom bitrate is kept, clamped to the allowed range.
    const custom = { ...stored, share: { ...stored.share, video: { ...stored.share.video, customKbps: 1e9 } } }
    expect(parseSettings(JSON.stringify(custom)).share.video.customKbps).toBe(CUSTOM_KBPS.max)
  })

  it('migrates a quality preset saved by an older version', () => {
    const old = (quality: string) => parseSettings(JSON.stringify({ share: { quality } })).share
    expect(old('auto')).toMatchObject({ video: { resolution: '1080', fps: 30, level: 'standard', customKbps: null }, autoLower: true })
    expect(old('1080p-ultra')).toMatchObject({ video: { resolution: '1080', level: 'very-high' }, autoLower: false })
    expect(old('low')).toMatchObject({ video: { resolution: '540', level: 'low' }, autoLower: false })
    // Unknown presets fall back to the defaults.
    expect(old('8k')).toMatchObject({ video: DEFAULT_SETTINGS.share.video, autoLower: DEFAULT_SETTINGS.share.autoLower })
  })

  it('falls back field by field on stale or invalid values', () => {
    const s = parseSettings(
      JSON.stringify({
        name: 5,
        share: { source: 'projector', systemAudio: 'yes', mic: true, video: { resolution: '8k', fps: 24, level: 'ultra', customKbps: 'x' }, autoLower: 1, k: 0, m: 2.5 },
        view: { quality: 'ultra', buffering: 'huge', chatOpen: false },
      }),
    )
    expect(s).toEqual({
      name: '',
      share: { ...DEFAULT_SETTINGS.share, mic: true },
      view: { quality: 'auto', buffering: 'auto', chatOpen: false },
    })
  })

  it('rejects inherited keys and non-object sections', () => {
    expect(parseSettings(JSON.stringify({ share: { quality: 'toString' } })).share.video).toEqual(DEFAULT_SETTINGS.share.video)
    expect(parseSettings(JSON.stringify({ share: null, view: 'x' }))).toEqual(DEFAULT_SETTINGS)
  })
})

describe('stripe limits', () => {
  it('clamps and rounds into the limits the stored settings accept', () => {
    expect(clampStripes(0, STRIPE_LIMITS.k)).toBe(1)
    expect(clampStripes(99, STRIPE_LIMITS.k)).toBe(16)
    expect(clampStripes(2.6, STRIPE_LIMITS.k)).toBe(3)
    expect(clampStripes(-1, STRIPE_LIMITS.m)).toBe(0)
    expect(clampStripes(9, STRIPE_LIMITS.m)).toBe(8)
    const s = parseSettings(JSON.stringify({ share: { k: STRIPE_LIMITS.k.max, m: STRIPE_LIMITS.m.max } }))
    expect([s.share.k, s.share.m]).toEqual([16, 8])
    expect(parseSettings(JSON.stringify({ share: { k: 17, m: 9 } })).share).toMatchObject({ k: 4, m: 1 })
  })

  it('defaults within the limits', () => {
    const { k, m } = DEFAULT_SETTINGS.share
    expect(clampStripes(k, STRIPE_LIMITS.k)).toBe(k)
    expect(clampStripes(m, STRIPE_LIMITS.m)).toBe(m)
  })
})

describe('supportedSource', () => {
  const desktop = { screen: true, camera: true }
  const phone = { screen: false, camera: true }

  it('keeps any source the device can capture', () => {
    for (const src of ['screen', 'window', 'tab', 'camera', 'test'] as const) expect(supportedSource(src, desktop)).toBe(src)
  })

  it('switches a phone from a screen source to its camera', () => {
    for (const src of ['screen', 'window', 'tab'] as const) expect(supportedSource(src, phone)).toBe('camera')
    expect(supportedSource('test', phone)).toBe('test')
  })

  it('falls back to the screen without a camera API, and keeps the saved choice when neither works', () => {
    expect(supportedSource('camera', { screen: true, camera: false })).toBe('screen')
    expect(supportedSource('camera', { screen: false, camera: false })).toBe('camera')
    expect(supportedSource('tab', { screen: false, camera: false })).toBe('tab')
  })

  it('reads a stored camera facing, defaulting to the front camera', () => {
    expect(parseSettings(JSON.stringify({ share: { source: 'camera', facing: 'environment' } })).share).toMatchObject({ source: 'camera', facing: 'environment' })
    expect(parseSettings(JSON.stringify({ share: { facing: 'sideways' } })).share.facing).toBe('user')
  })
})
