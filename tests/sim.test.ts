// Regression gate on the planner and publisher policy under churn (sim/simulator.ts). A small
// scenario (100 viewers, 240 s, mean lifetime 240 s, 2.5 Mbps with audio) over a few seeds.
// Thresholds leave a safety margin over the values measured when they were set (in comments);
// a change that trips one should explain why the tree got worse, or move the threshold knowingly.
import { describe, expect, it } from 'vitest'
import { simulate, simulateLossy, type LossyMetrics, type SimMetrics, type SimOptions } from '../sim/simulator'

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
      expect(r.stallPct).toBeLessThan(1) // measured 0.10 / 0.38 / 0.25
      expect(r.p95).toBeLessThan(550) // measured 370 / 369 / 396 ms
      expect(r.maxDepth).toBeLessThanOrEqual(6) // measured 4
    }
    expect(mean(withParity, (r) => r.stallPct)).toBeLessThan(0.6) // measured 0.25
    expect(mean(withParity, (r) => r.p50)).toBeLessThan(420) // measured 324 ms
    expect(mean(withParity, (r) => r.degradedPct)).toBeLessThan(8) // measured 1.15
    // Parity is what absorbs churn: without it, stalls are ~25x as common.
    expect(mean(noParity, (r) => r.stallPct)).toBeLessThan(15) // measured 6.00
    expect(mean(withParity, (r) => r.stallPct)).toBeLessThan(mean(noParity, (r) => r.stallPct) / 5)
  })

  it('routes around late relays', { timeout: 30_000 }, () => {
    const seeds = [1, 2]
    const handled = runAll({ k: 4, m: 1, lateFrac: 0.25, handleLate: true }, seeds)
    const ignored = runAll({ k: 4, m: 1, lateFrac: 0.25, handleLate: false }, seeds)
    for (const r of handled) expect(r.p95).toBeLessThan(750) // measured 585 / 584 ms
    // measured 394 vs 541 ms
    expect(mean(handled, (r) => r.p50)).toBeLessThan(0.9 * mean(ignored, (r) => r.p50))
  })

  it('keeps one lossy viewer from forcing keyframes or demoting healthy relays', { timeout: 10_000 }, () => {
    // One viewer whose downlink keeps failing (sim/simulator.ts LossyOptions), 60 viewers, 120 s.
    const run = (policy: 'old' | 'new') => [1, 2, 3].map((seed) => simulateLossy({ k: 4, m: 1, peers: 60, seconds: 120, lifetimeS: 240, seed, lossy: { count: 1, policy } }))
    const old = run('old')
    const now = run('new')
    const mean = (rs: LossyMetrics[], f: (r: LossyMetrics) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length
    // Old: every need-key past a global 300 ms throttle forced a keyframe. New: KeyframeGate.
    for (const r of now) expect(r.forcedKeysPerMin).toBeLessThanOrEqual(4) // measured 1.5 / 2.5 / 2.0
    expect(mean(old, (r) => r.forcedKeysPerMin)).toBeGreaterThan(8) // measured 12.5
    expect(mean(now, (r) => r.forcedKeysPerMin)).toBeLessThan(mean(old, (r) => r.forcedKeysPerMin) / 4) // measured 1/6 (2.0 vs 12.5)
    // Old: every complaint counted against the parent. New: only corroborated ones.
    // (What remains under new is blame for single-stripe stalls, which do look like the parent's fault.)
    expect(mean(old, (r) => r.relayFailuresMean)).toBeGreaterThan(0.08) // measured 0.19
    expect(mean(now, (r) => r.relayFailuresMean)).toBeLessThan(0.05) // measured 0.022
    expect(mean(now, (r) => r.relayFailuresMean)).toBeLessThan(mean(old, (r) => r.relayFailuresMean) / 5) // measured 1/9
  })
})
