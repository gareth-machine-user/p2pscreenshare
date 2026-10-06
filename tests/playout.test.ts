import { describe, expect, it } from 'vitest'
import { Playout } from '../src/media/playout'

const SRC = 44_100
const OUT = 48_000
const CHUNK = 882 // 20 ms at 44.1 kHz
const BLOCK = 128
const FREQ = 440
const AMP = 0.5
/** Largest step between consecutive output samples of the sine (plus slack): anything bigger is a click. */
const MAX_STEP = ((2 * Math.PI * FREQ * AMP) / OUT) * 1.3

function chunk(k: number): Float32Array[] {
  const a = new Float32Array(CHUNK)
  for (let i = 0; i < CHUNK; i++) a[i] = AMP * Math.sin((2 * Math.PI * FREQ * (k * CHUNK + i)) / SRC)
  return [a]
}

/**
 * Plays `seconds` of a sine through the playout, pushing chunk k when it arrives (`arrive(k)`, s) with
 * target time `target(k)` (s). Returns the output and the largest sample-to-sample jump.
 */
function run(seconds: number, opts: { target?: (k: number) => number; arrive?: (k: number) => number; skip?: (k: number) => boolean } = {}) {
  const target = opts.target ?? ((k) => 0.2 + (k * CHUNK) / SRC)
  const arrive = opts.arrive ?? ((k) => target(k) - 0.15)
  const p = new Playout(OUT)
  const out: number[] = []
  let next = 0
  for (let b = 0; b * BLOCK < seconds * OUT; b++) {
    const now = (b * BLOCK) / OUT
    while (arrive(next) <= now) {
      if (!opts.skip?.(next)) p.push(chunk(next), SRC, target(next))
      next++
    }
    const l = new Float32Array(BLOCK)
    const r = new Float32Array(BLOCK)
    p.render([l, r], now)
    out.push(...l)
  }
  let maxJump = 0
  for (let i = 1; i < out.length; i++) maxJump = Math.max(maxJump, Math.abs(out[i] - out[i - 1]))
  return { p, out, maxJump }
}

describe('audio playout', () => {
  it('plays a steady stream with no clicks, no underruns, and on time', () => {
    const { p, out, maxJump } = run(3)
    expect(maxJump).toBeLessThan(MAX_STEP)
    expect(p.stats.underruns).toBe(0)
    expect(p.stats.resyncs).toBe(0)
    expect(Math.abs(p.stats.errorMs)).toBeLessThan(2)
    // Silent until the first chunk's target time (0.2 s), then sound.
    expect(Math.max(...out.slice(0, 0.19 * OUT).map(Math.abs))).toBe(0)
    expect(Math.max(...out.slice(0.3 * OUT, 0.4 * OUT).map(Math.abs))).toBeGreaterThan(AMP * 0.95)
  })

  it('absorbs jittery target times without re-syncing or clicking', () => {
    const jitter = (k: number) => (((k * 7919) % 11) - 5) / 1000 // ±5 ms
    const { p, maxJump } = run(4, { target: (k) => 0.2 + (k * CHUNK) / SRC + jitter(k), arrive: (k) => 0.05 + (k * CHUNK) / SRC + 3 * jitter(k) })
    expect(maxJump).toBeLessThan(MAX_STEP)
    expect(p.stats.resyncs).toBe(0)
    expect(p.stats.underruns).toBe(0)
  })

  it('follows a slowly drifting clock by changing speed, not by jumping', () => {
    // The sender's clock runs 0.5% slow relative to ours.
    const { p, maxJump } = run(6, { target: (k) => 0.2 + ((k * CHUNK) / SRC) * 1.005 })
    expect(maxJump).toBeLessThan(MAX_STEP * 1.1)
    expect(p.stats.resyncs).toBe(0)
    expect(Math.abs(p.stats.errorMs)).toBeLessThan(15)
  })

  it('fades across a skipped frame instead of cutting', () => {
    const { p, maxJump } = run(3, { skip: (k) => k === 60 || k === 61 })
    expect(maxJump).toBeLessThan(0.08)
    expect(p.stats.underruns).toBe(0)
  })

  it('fades out when the stream stops and back in when it resumes', () => {
    // Nothing arrives for chunks 50-99 (a 1 s outage).
    const { p, maxJump } = run(4, { skip: (k) => k >= 50 && k < 100 })
    expect(p.stats.underruns).toBe(1)
    expect(maxJump).toBeLessThan(0.08)
  })

  it('re-syncs with fades when the timeline jumps', () => {
    // The playout delay jumps 300 ms later at chunk 80.
    const { p, maxJump } = run(5, { target: (k) => 0.2 + (k * CHUNK) / SRC + (k >= 80 ? 0.3 : 0), arrive: (k) => 0.05 + (k * CHUNK) / SRC })
    expect(p.stats.resyncs).toBe(1)
    expect(maxJump).toBeLessThan(0.08)
  })
})
