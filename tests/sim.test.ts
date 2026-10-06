// Regression gate on the planner and publisher policy under churn (sim/simulator.ts). A small
// scenario (100 viewers, 240 s, mean lifetime 240 s, 2.5 Mbps with audio) over a few seeds.
// Thresholds leave a safety margin over the values measured when they were set (in comments);
// a change that trips one should explain why the tree got worse, or move the threshold knowingly.
import { describe, expect, it } from 'vitest'
import { simulate, type SimMetrics, type SimOptions } from '../sim/simulator'

const SEEDS = [1, 2, 3]
const SCENARIO = { peers: 100, seconds: 240, lifetimeS: 240 }

const runAll = (o: Omit<SimOptions, 'seed'>, seeds = SEEDS): SimMetrics[] => seeds.map((seed) => simulate({ ...SCENARIO, ...o, seed }))
const mean = (rs: SimMetrics[], f: (r: SimMetrics) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length

describe('simulator', () => {
  it('is deterministic for a seed', () => {
    const o = { k: 2, m: 1, peers: 30, seconds: 60, seed: 9 }
    expect(simulate(o)).toEqual(simulate(o))
  })

  it('keeps 4+1 stripes smooth under churn', { timeout: 30_000 }, () => {
    const withParity = runAll({ k: 4, m: 1 })
    const noParity = runAll({ k: 4, m: 0 })
    for (const r of withParity) {
      expect(r.stallPct).toBeLessThan(1) // measured 0.09 / 0.29 / 0.25
      expect(r.p95).toBeLessThan(550) // measured 393 / 364 / 441 ms
      expect(r.maxDepth).toBeLessThanOrEqual(6) // measured 4
    }
    expect(mean(withParity, (r) => r.stallPct)).toBeLessThan(0.6) // measured 0.21
    expect(mean(withParity, (r) => r.p50)).toBeLessThan(420) // measured 334 ms
    expect(mean(withParity, (r) => r.degradedPct)).toBeLessThan(8) // measured 2.07
    // Parity is what absorbs churn: without it, stalls are ~30x as common.
    expect(mean(noParity, (r) => r.stallPct)).toBeLessThan(15) // measured 6.82
    expect(mean(withParity, (r) => r.stallPct)).toBeLessThan(mean(noParity, (r) => r.stallPct) / 5)
  })

  it('routes around late relays', { timeout: 30_000 }, () => {
    const seeds = [1, 2]
    const handled = runAll({ k: 4, m: 1, lateFrac: 0.25, handleLate: true }, seeds)
    const ignored = runAll({ k: 4, m: 1, lateFrac: 0.25, handleLate: false }, seeds)
    for (const r of handled) expect(r.p95).toBeLessThan(750) // measured 602 / 599 ms
    // measured 398 vs 537 ms
    expect(mean(handled, (r) => r.p50)).toBeLessThan(0.9 * mean(ignored, (r) => r.p50))
  })
})
