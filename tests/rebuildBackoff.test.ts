import { describe, expect, it } from 'vitest'
import { RebuildBackoff } from '../src/media/rebuildBackoff'

describe('RebuildBackoff', () => {
  it('rebuilds at once after a one-off error, then doubles the gap up to the cap', () => {
    const b = new RebuildBackoff(1000, 10_000, 30_000)
    // Each failure arrives right after the previous rebuild ran.
    let now = 0
    const waits: number[] = []
    for (let i = 0; i < 7; i++) {
      const w = b.next(now)
      waits.push(w)
      now += w
    }
    expect(waits).toEqual([0, 1000, 2000, 4000, 8000, 10_000, 10_000])
  })

  it('a failure arriving after part of the gap waits only for the rest of it', () => {
    const b = new RebuildBackoff(1000, 10_000, 30_000)
    expect(b.next(0)).toBe(0)
    expect(b.next(400)).toBe(600)
  })

  it('starts over after a quiet spell', () => {
    const b = new RebuildBackoff(1000, 10_000, 30_000)
    b.next(0)
    b.next(0)
    b.next(1000)
    expect(b.next(40_000)).toBe(0)
    expect(b.next(40_000)).toBe(1000)
  })

  it('tryNow allows a rebuild only once the gap has passed', () => {
    const b = new RebuildBackoff(1000, 10_000, 30_000)
    expect(b.tryNow(0)).toBe(true)
    expect(b.tryNow(500)).toBe(false)
    expect(b.tryNow(1000)).toBe(true)
    expect(b.tryNow(2500)).toBe(false)
    expect(b.tryNow(3000)).toBe(true)
    expect(b.tryNow(40_000)).toBe(true) // quiet: the gap is back to the start
    expect(b.tryNow(40_100)).toBe(false)
  })
})
