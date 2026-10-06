/// <reference types="svelte" />
/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app types these src/ui modules use: runes, import.meta.env.)
import { describe, expect, it } from 'vitest'
import { clampStripes, DEFAULT_SETTINGS, QUALITY_PRESETS, parseSettings, STRIPE_LIMITS } from '../src/ui/settings.svelte'

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
      share: { source: 'tab', systemAudio: false, mic: true, quality: '1080p-ultra', k: 6, m: 0 },
      view: { quality: 'preview', buffering: 'extra', chatOpen: false },
    }
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back field by field on stale or invalid values', () => {
    const s = parseSettings(
      JSON.stringify({
        name: 5,
        share: { source: 'camera', systemAudio: 'yes', mic: true, quality: '8k', k: 0, m: 2.5 },
        view: { quality: 'ultra', buffering: 'huge', chatOpen: false },
      }),
    )
    expect(s).toEqual({
      name: '',
      share: { ...DEFAULT_SETTINGS.share, mic: true },
      view: { quality: 'auto', buffering: 'auto', chatOpen: false },
    })
    expect(QUALITY_PRESETS[s.share.quality]).toBeDefined()
  })

  it('rejects inherited keys and non-object sections', () => {
    expect(parseSettings(JSON.stringify({ share: { quality: 'toString' } })).share.quality).toBe('auto')
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
