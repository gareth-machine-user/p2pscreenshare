import { describe, expect, it } from 'vitest'
import {
  bitsPerPixel,
  clampKbps,
  CUSTOM_KBPS,
  describeQuality,
  fromLegacyPreset,
  HIGH_BPP,
  levelKbps,
  maxSizeFor,
  pixelsFor,
  targetKbps,
  type QualityLevel,
} from '../src/media/quality'

const at = (res: '1080' | '1440' | '2160', fps: number, level: QualityLevel) => levelKbps(level, pixelsFor(res), fps) / 1000

describe('quality levels', () => {
  it('match the 1080p30 base figures', () => {
    expect([at('1080', 30, 'low'), at('1080', 30, 'standard'), at('1080', 30, 'high'), at('1080', 30, 'very-high'), at('1080', 30, 'lossless')]).toEqual([
      2.5, 5, 9, 15, 25,
    ])
  })

  it('scale with frame rate and resolution, a little less than linearly', () => {
    // The table shown to the user: 1080p60, 1440p60 and 2160p60, Low through Near-lossless.
    expect(at('1080', 60, 'low')).toBeCloseTo(4, 0)
    expect(at('1080', 60, 'high')).toBeCloseTo(14.5, 0)
    expect(at('1440', 60, 'standard')).toBeCloseTo(12.5, 0)
    expect(at('2160', 60, 'very-high')).toBeGreaterThan(60)
    expect(at('2160', 60, 'very-high')).toBeLessThan(80)
    // Per pixel, bigger frames get fewer bits, but never fewer in total.
    for (const level of ['low', 'standard', 'high', 'very-high', 'lossless'] as const) {
      expect(at('1440', 30, level)).toBeGreaterThan(at('1080', 30, level))
      expect(at('1440', 30, level) / at('1080', 30, level)).toBeLessThan(pixelsFor('1440') / pixelsFor('1080'))
    }
  })

  it('every level is denser than the one below at every size and rate', () => {
    for (const res of ['1080', '1440', '2160'] as const)
      for (const fps of [30, 60]) {
        const r = (['low', 'standard', 'high', 'very-high', 'lossless'] as const).map((l) => at(res, fps, l))
        for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1])
      }
  })

  it('High and above are past the hardware-encoder threshold; Standard and below are not', () => {
    const bpp = (level: QualityLevel, fps: number) => bitsPerPixel(levelKbps(level, pixelsFor('1080'), fps), 1920, 1080, fps)
    for (const fps of [30, 60]) {
      expect(bpp('standard', fps)).toBeLessThan(HIGH_BPP)
      expect(bpp('high', fps)).toBeGreaterThanOrEqual(HIGH_BPP)
    }
  })
})

describe('target bitrate', () => {
  it('a custom bitrate overrides the level, clamped to the allowed range', () => {
    expect(targetKbps({ resolution: '1080', fps: 30, level: 'low', customKbps: 42_000 })).toBe(42_000)
    expect(targetKbps({ resolution: '1080', fps: 30, level: 'low', customKbps: 10 })).toBe(CUSTOM_KBPS.min)
    expect(clampKbps(1e9)).toBe(CUSTOM_KBPS.max)
  })

  it('native uses the screen size', () => {
    const q = { resolution: 'native', fps: 30, level: 'standard', customKbps: null } as const
    expect(targetKbps(q, [3840, 2160])).toBe(targetKbps({ ...q, resolution: '2160' }))
    expect(targetKbps(q, [1920, 1080])).toBe(5000)
  })

  it('capture caps are 16:9 boxes; native is uncapped', () => {
    expect(maxSizeFor('1080')).toEqual([1920, 1080])
    expect(maxSizeFor('540')).toEqual([960, 540])
    expect(maxSizeFor('native')).toEqual([7680, 4320])
  })

  it('describes a choice in one line', () => {
    expect(describeQuality({ resolution: '1080', fps: 60, level: 'high', customKbps: null })).toBe('1080p60 · High · 15 Mbps')
    expect(describeQuality({ resolution: '720', fps: 30, level: 'low', customKbps: 800 })).toBe('720p30 · Custom · 800 kbps')
  })
})

describe('legacy presets', () => {
  it('map to the nearest new choice; only Auto lowers automatically', () => {
    expect(fromLegacyPreset('auto')).toEqual({ quality: { resolution: '1080', fps: 30, level: 'standard', customKbps: null }, autoLower: true })
    expect(fromLegacyPreset('1080p-ultra')?.quality.level).toBe('very-high')
    expect(fromLegacyPreset('720p')?.autoLower).toBe(false)
    expect(fromLegacyPreset('8k')).toBeNull()
  })
})
