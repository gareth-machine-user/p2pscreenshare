import { describe, expect, it } from 'vitest'
import { CapacityEstimator, feasibilityRatio, feasibleBitrate, rebalanceWeights, splitBudget } from '../src/session/capacity'

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
