/// <reference types="svelte" />
/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app types these src/ui modules use: runes, import.meta.env.)
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, QUALITY_PRESETS, parseSettings } from '../src/ui/settings.svelte'

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
      view: { quality: 'preview', chatOpen: false },
    }
    expect(parseSettings(JSON.stringify(stored))).toEqual(stored)
  })

  it('falls back field by field on stale or invalid values', () => {
    const s = parseSettings(
      JSON.stringify({
        name: 5,
        share: { source: 'camera', systemAudio: 'yes', mic: true, quality: '8k', k: 0, m: 2.5 },
        view: { quality: 'ultra', chatOpen: false },
      }),
    )
    expect(s).toEqual({
      name: '',
      share: { ...DEFAULT_SETTINGS.share, mic: true },
      view: { quality: 'auto', chatOpen: false },
    })
    expect(QUALITY_PRESETS[s.share.quality]).toBeDefined()
  })

  it('rejects inherited keys and non-object sections', () => {
    expect(parseSettings(JSON.stringify({ share: { quality: 'toString' } })).share.quality).toBe('auto')
    expect(parseSettings(JSON.stringify({ share: null, view: 'x' }))).toEqual(DEFAULT_SETTINGS)
  })
})
