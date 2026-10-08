import { describe, expect, it } from 'vitest'
import { SortedWindow } from '../src/media/sortedWindow'

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('SortedWindow', () => {
  it('matches copying and sorting the window on every sample, on random input', () => {
    for (const seed of [1, 2, 3]) {
      const rand = rng(seed)
      const w = new SortedWindow()
      const ref: { at: number; value: number }[] = []
      const windowMs = 500
      let at = 0
      for (let i = 0; i < 5000; i++) {
        // Bursts of equal times, gaps that expire many at once, and repeated values.
        at += rand() < 0.3 ? 0 : rand() < 0.02 ? 400 * rand() : 10 * rand()
        const value = rand() < 0.5 ? Math.round(rand() * 20) : rand() * 1000 - 200
        w.add(at, value)
        ref.push({ at, value })
        const cutoff = at - windowMs
        w.expire(cutoff)
        while (ref.length && ref[0].at < cutoff) ref.shift()

        const sorted = ref.map((s) => s.value).sort((a, b) => a - b)
        expect(w.size).toBe(sorted.length)
        expect(w.min).toBe(sorted[0])
        for (const q of [0, 0.5, 0.9, 0.97, 1]) {
          expect(w.quantile(q), `seed ${seed} step ${i} q ${q}`).toBe(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))])
        }
      }
    }
  })

  it('is empty before any sample and after everything expired', () => {
    const w = new SortedWindow()
    expect(w.min).toBeUndefined()
    expect(w.quantile(0.5)).toBeUndefined()
    w.add(0, 5)
    w.add(1, 3)
    w.expire(2)
    expect(w.size).toBe(0)
    expect(w.min).toBeUndefined()
  })
})
