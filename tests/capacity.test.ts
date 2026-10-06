import { describe, expect, it } from 'vitest'
import { CapacityEstimator, PROBE_DROP_CONFIRM_MS, feasibilityRatio, feasibleBitrate, rebalanceWeights, splitBudget, uplinkIsFull } from '../src/session/capacity'

describe('budget split', () => {
  it('a viewer offers floor(B / stripe kbps) slots', () => {
    const r = splitBudget(4000, [], [{ id: 1, stripeKbps: 645, weight: 1 }])
    expect(r.budgetKbps).toBe(3000)
    expect(r.offers[1]).toBe(4)
  })

  it('no estimate yet: no offers, but a publisher still emits every stripe', () => {
    const r = splitBudget(null, [{ id: 7, stripeKbps: 600, stripes: 3 }], [{ id: 1, stripeKbps: 600, weight: 1 }])
    expect(r.rootSlots[7]).toBe(3)
    expect(r.offers[1]).toBe(0)
  })

  it("a publisher's own roots come first", () => {
    // Small budget: everything goes to the root, nothing is offered elsewhere.
    const small = splitBudget(2600, [{ id: 7, stripeKbps: 645, stripes: 3 }], [{ id: 1, stripeKbps: 645, weight: 1 }])
    expect(small.rootSlots[7]).toBe(3)
    expect(small.offers[1]).toBe(0)
    // Huge budget: the root is capped at maxFanout per stripe and the rest is offered.
    const big = splitBudget(100_000, [{ id: 7, stripeKbps: 500, stripes: 2 }], [{ id: 1, stripeKbps: 500, weight: 1 }], 16)
    expect(big.rootSlots[7]).toBe(32)
    expect(big.offers[1]).toBe(16)
  })

  it('splits across watched channels by stripe bitrate and weight', () => {
    const even = splitBudget(8000, [], [
      { id: 1, stripeKbps: 600, weight: 1 },
      { id: 2, stripeKbps: 120, weight: 1 },
    ])
    // Proportional to bitrate: about the same slot count each.
    expect(even.offers[1]).toBe(8)
    expect(even.offers[2]).toBe(8)
    const skewed = splitBudget(8000, [], [
      { id: 1, stripeKbps: 600, weight: 3 },
      { id: 2, stripeKbps: 600, weight: 1 },
    ])
    expect(skewed.offers[1]).toBeGreaterThan(skewed.offers[2])
    expect(skewed.offers[1] + skewed.offers[2]).toBeLessThanOrEqual(10)
  })
})

describe('capacity estimate', () => {
  it('caps on drops and relaxes back to the probe value', () => {
    const e = new CapacityEstimator()
    expect(e.estimateKbps).toBeNull()
    e.setProbe(5000)
    expect(e.estimateKbps).toBe(5000)
    e.observe(2000, 0.1)
    expect(e.estimateKbps).toBe(1800)
    e.observe(1500, 0.1)
    expect(e.estimateKbps).toBe(1350)
    e.observe(1500, 0)
    expect(e.estimateKbps).toBeCloseTo(1417.5)
    for (let i = 0; i < 40; i++) e.observe(1500, 0)
    expect(e.estimateKbps).toBe(5000)
    expect(e.observedCapKbps).toBeNull()
  })

  it('probes raise the estimate freely and lower it a little at once', () => {
    const e = new CapacityEstimator()
    expect(e.setProbe(5000, 0)).toBe(true)
    expect(e.setProbe(20_000, 1000)).toBe(true)
    expect(e.estimateKbps).toBe(20_000)
    // Down to half or more: applied on one probe.
    expect(e.setProbe(10_000, 2000)).toBe(true)
    expect(e.estimateKbps).toBe(10_000)
  })

  it('a single probe cannot cut the estimate below half', () => {
    const e = new CapacityEstimator()
    e.setProbe(10_000, 0)
    expect(e.setProbe(1000, 1000)).toBe(false)
    expect(e.estimateKbps).toBe(10_000)
    expect(e.pendingDrop).toEqual({ kbps: 1000, at: 1000 })
    // A normal probe afterwards clears the suspicion.
    expect(e.setProbe(9000, 2000)).toBe(true)
    expect(e.pendingDrop).toBeNull()
    // So the next low probe needs confirming again.
    expect(e.setProbe(1000, 3000)).toBe(false)
    expect(e.estimateKbps).toBe(9000)
  })

  it('a second low probe within the window confirms the drop (the higher of the two)', () => {
    const e = new CapacityEstimator()
    e.setProbe(10_000, 0)
    e.setProbe(2000, 1000)
    expect(e.setProbe(3000, 60_000)).toBe(true)
    expect(e.estimateKbps).toBe(3000)
    expect(e.pendingDrop).toBeNull()
  })

  it('a low probe outside the window starts over', () => {
    const e = new CapacityEstimator()
    e.setProbe(10_000, 0)
    e.setProbe(2000, 1000)
    expect(e.setProbe(2000, 1000 + PROBE_DROP_CONFIRM_MS + 1)).toBe(false)
    expect(e.estimateKbps).toBe(10_000)
  })

  it('drops on a full uplink confirm a pending drop', () => {
    const e = new CapacityEstimator()
    e.setProbe(10_000, 0)
    e.setProbe(2000, 1000)
    // No drops: nothing confirmed.
    e.observe(1500, 0, 2000)
    expect(e.estimateKbps).toBe(10_000)
    e.observe(1500, 0.1, 3000)
    expect(e.probeKbps).toBe(2000)
    expect(e.pendingDrop).toBeNull()
    // And the observed cap applies as usual.
    expect(e.estimateKbps).toBe(1350)
  })
})

describe('competing publishers', () => {
  it('moves weight towards channels with a deficit, a step at a time', () => {
    let w: Record<string, number> = { a: 1, b: 1 }
    w = rebalanceWeights(w, { a: 3, b: 0 })
    expect(w.a).toBeCloseTo(1.1)
    expect(w.b).toBeCloseTo(0.9)
    for (let i = 0; i < 50; i++) w = rebalanceWeights(w, { a: 3, b: 0 })
    // b keeps a floor, so it is never starved in turn; the total is preserved.
    expect(w.b).toBeCloseTo(0.2)
    expect(w.a + w.b).toBeCloseTo(2)
  })

  it('does nothing with one channel, or when nobody (or everybody) is short', () => {
    expect(rebalanceWeights({ a: 1 }, { a: 5 })).toEqual({ a: 1 })
    expect(rebalanceWeights({ a: 1, b: 1 }, {})).toEqual({ a: 1, b: 1 })
    expect(rebalanceWeights({ a: 1, b: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 1 })
  })
})

describe('feasibility and auto quality', () => {
  it('compares slot supply with N × S', () => {
    expect(feasibilityRatio(8, 3, 24)).toBe(1)
    expect(feasibilityRatio(8, 3, 12)).toBe(0.5)
    expect(feasibilityRatio(0, 3, 0)).toBe(Infinity)
  })

  it('suggests a bitrate the audience can carry', () => {
    expect(feasibleBitrate(2500, 1.2)).toBe(2500)
    expect(feasibleBitrate(2500, 0.5)).toBe(1150)
    expect(feasibleBitrate(2500, 0.05)).toBe(300)
  })

  it('offers nothing (not NaN) to a channel announcing no stripe bitrate', () => {
    const r = splitBudget(4000, [], [{ id: 1, stripeKbps: 0, weight: 1 }, { id: 2, stripeKbps: 600, weight: 1 }])
    expect(r.offers[1]).toBe(0)
    expect(Number.isFinite(r.offers[2])).toBe(true)
  })
})

describe('is the uplink full?', () => {
  /** A peer: congested?, its path RTT inflated? (null: no RTT signal), drops/s. */
  const p = (congested: boolean, pathQueued: boolean | null, drops = congested ? 3 : 0) => ({ congested, pathQueued, drops })

  it('congested with inflated RTTs is full', () => {
    expect(uplinkIsFull([p(true, true), p(true, true), p(false, false)])).toEqual({ congested: 2, active: 3, signal: 'rtt' })
    expect(uplinkIsFull([p(true, true), p(true, true)])).toEqual({ congested: 2, active: 2, signal: 'rtt' })
  })
  it('congested with flat RTTs is the connections’ own ceiling, not a full uplink', () => {
    expect(uplinkIsFull([p(true, false), p(true, false), p(true, false)])).toBeNull()
    // Only one of the congested peers shows queueing: not most of them.
    expect(uplinkIsFull([p(true, true), p(true, false), p(true, false)])).toBeNull()
  })
  it('no RTT signal: congestion alone decides (the majority rule)', () => {
    expect(uplinkIsFull([p(true, null), p(true, null), p(false, null)])).toEqual({ congested: 2, active: 3, signal: 'fallback' })
    expect(uplinkIsFull([p(true, null), p(false, null), p(false, null)])).toBeNull()
    // Mixed: a congested peer without RTT counts, one with a flat RTT doesn't.
    expect(uplinkIsFull([p(true, null), p(true, true), p(true, false)])).toEqual({ congested: 2, active: 3, signal: 'fallback' })
  })
  it('heavy drops to most peers are full even with flat RTTs (fq_codel / SQM routers)', () => {
    expect(uplinkIsFull([p(true, false, 15), p(true, false, 12), p(false, false, 0)])).toEqual({ congested: 2, active: 3, signal: 'loss' })
    // Light drops with a flat RTT are still the connections' own ceiling.
    expect(uplinkIsFull([p(true, false, 4), p(true, false, 4)])).toBeNull()
    // One lossy peer of two is that receiver.
    expect(uplinkIsFull([p(true, false, 30), p(false, false, 0)])).toBeNull()
    // Drops on a peer that isn't congested (on most of its connections) don't count: one stalled
    // or backed-up lane of several.
    expect(uplinkIsFull([p(false, false, 30)])).toBeNull()
    expect(uplinkIsFull([p(false, false, 30), p(false, false, 30)])).toBeNull()
  })
  it('one slow receiver among several is not a full uplink, whatever its path shows', () => {
    expect(uplinkIsFull([p(true, true), p(false, false), p(false, false)])).toBeNull()
    expect(uplinkIsFull([p(true, true, 40), p(false, false)])).toBeNull()
  })
  it('a single peer: a path bottleneck anywhere counts, its own ceiling does not', () => {
    expect(uplinkIsFull([p(true, true)])).toEqual({ congested: 1, active: 1, signal: 'rtt' })
    expect(uplinkIsFull([p(true, false)])).toBeNull()
    expect(uplinkIsFull([p(true, false, 20)])).toEqual({ congested: 1, active: 1, signal: 'loss' })
    expect(uplinkIsFull([p(true, null)])).toEqual({ congested: 1, active: 1, signal: 'fallback' })
    expect(uplinkIsFull([p(false, true)])).toBeNull() // queueing on the path, but our link keeps up
  })
  it('nothing congested, or no peers, is not full', () => {
    expect(uplinkIsFull([p(false, true), p(false, null)])).toBeNull()
    expect(uplinkIsFull([])).toBeNull()
  })
})
