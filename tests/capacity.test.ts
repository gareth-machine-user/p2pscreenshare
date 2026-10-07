import { describe, expect, it } from 'vitest'
import {
  CAPACITY_WINDOW_MS,
  CapacityModel,
  deliveredKbps,
  feasibilityRatio,
  feasibleBitrate,
  linkWindow,
  MaxFilter,
  rebalanceWeights,
  splitBudget,
  type ConnWindow,
  type LinkSnap,
} from '../src/session/capacity'

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

describe('delivered rate', () => {
  it('is what was handed to the channel, less what its send buffer grew by', () => {
    // 1 MB handed over 2 s, the buffer grew from 0 to 64 KB: 936 KB delivered.
    expect(deliveredKbps(1_000_000, 0, 64_000, 2000)).toBeCloseTo((936_000 * 8) / 2000)
    // A buffer that shrank delivered more than was handed meanwhile.
    expect(deliveredKbps(100_000, 60_000, 10_000, 1000)).toBeCloseTo(1200)
    // Nothing handed, the buffer stuck: nothing delivered (never negative).
    expect(deliveredKbps(0, 50_000, 50_000, 2000)).toBe(0)
    expect(deliveredKbps(0, 10_000, 60_000, 2000)).toBe(0)
    expect(deliveredKbps(1000, 0, 0, 0)).toBe(0)
  })

  it('a window between two snapshots: backlogged when the queue never emptied with media queueing or dropped, stalled when it stalled', () => {
    const a: LinkSnap = { at: 0, handed: 0, buffered: 0, busyMs: 0, items: 0, mediaBytes: 0, drops: 0, qSum: 0, qN: 0, lastStallAt: -Infinity, headAgeMs: 0 }
    const b: LinkSnap = { ...a, at: 2000, handed: 2_000_000, buffered: 64_000, busyMs: 1900, items: 1500, mediaBytes: 1_500_000, drops: 10, qSum: 1500 * 300, qN: 1500, headAgeMs: 100 }
    const w = linkWindow('l', 'p', a, b)
    expect(w.kbps).toBeCloseTo(((2_000_000 - 64_000) * 8) / 2000)
    expect(w).toMatchObject({ id: 'l', peer: 'p', active: true, backlogged: true, stalled: false, queueMs: 300, mediaKbps: 6000, dropsPerS: 5 })
    // Busy for less than 90% of the window: not backlogged. The oldest waiting item counts as queueing.
    expect(linkWindow('l', 'p', a, { ...b, busyMs: 1700, headAgeMs: 1200 })).toMatchObject({ backlogged: false, queueMs: 1200 })
    expect(linkWindow('l', 'p', a, { ...b, lastStallAt: 500 }).stalled).toBe(true)
    // A queue that never emptied but held nothing long and dropped nothing: a busy link, not a full one.
    expect(linkWindow('l', 'p', a, { ...b, drops: 0, qSum: 1500 * 5, headAgeMs: 3 }).backlogged).toBe(false)
    expect(linkWindow('l', 'p', a, { ...b, drops: 0, qSum: 1500 * 200 }).backlogged).toBe(true)
    expect(linkWindow('l', 'p', a, { ...b, qSum: 1500 * 5, headAgeMs: 3 }).backlogged).toBe(true)
    // Idle: no media, nothing waiting.
    expect(linkWindow('l', 'p', a, { ...a, at: 2000 }).active).toBe(false)
  })
})

describe('max filter', () => {
  it('is the most delivered while backlogged over the last 10 s, held in between', () => {
    const f = new MaxFilter()
    expect(f.kbps).toBeNull()
    f.sample(0, 5000)
    f.sample(2000, 4000)
    expect(f.kbps).toBe(5000)
    // The 5000 ages out: the most in the last 10 s is 4000.
    f.sample(CAPACITY_WINDOW_MS + 1, 3000)
    expect(f.kbps).toBe(4000)
    f.sample(CAPACITY_WINDOW_MS + 2001, 3000)
    expect(f.kbps).toBe(3000)
    // No more backlogged windows: it holds.
    expect(f.kbps).toBe(3000)
  })

  it('unbacklogged windows only raise it, and never start it', () => {
    const f = new MaxFilter()
    f.raise(0, 9000)
    expect(f.kbps).toBeNull()
    f.raise(0, 9000, true)
    expect(f.kbps).toBe(9000)
    f.raise(2000, 2000)
    expect(f.kbps).toBe(9000)
    f.raise(4000, 12_000)
    expect(f.kbps).toBe(12_000)
    // A backlogged window shortly after: the raise is still within the 10 s.
    f.sample(6000, 8000)
    expect(f.kbps).toBe(12_000)
    f.sample(4000 + CAPACITY_WINDOW_MS + 1, 8000)
    expect(f.kbps).toBe(8000)
  })

  it('drops at once to a backlogged sample queueing over a second', () => {
    const f = new MaxFilter()
    f.sample(0, 20_000)
    f.sample(2000, 6000, 400)
    expect(f.kbps).toBe(20_000)
    f.sample(4000, 6000, 1500)
    expect(f.kbps).toBe(6000)
  })
})

describe('capacity model', () => {
  const w = (id: string, peer: string, kbps: number, o: Partial<ConnWindow> = {}): ConnWindow => ({
    id,
    peer,
    kbps,
    active: true,
    backlogged: false,
    stalled: false,
    queueMs: 0,
    ...o,
  })

  it('knows nothing until the uplink is measured; a probe (every connection backlogged) measures it', () => {
    const m = new CapacityModel()
    m.update(0, [w('a0', 'a', 3000), w('a1', 'a', 2000)])
    expect(m.uplinkKbps).toBeNull()
    expect(m.peer('a')).toEqual({ kbps: null, bound: false })
    m.update(2000, [w('a0', 'a', 30_000, { backlogged: true }), w('a1', 'a', 25_000, { backlogged: true })], { probe: true })
    expect(m.uplinkKbps).toBe(55_000)
    // A probe pushes every connection at once: each one's share is a lower bound, not its limit.
    expect(m.peer('a')).toEqual({ kbps: 55_000, bound: false })
  })

  it('the uplink: most media connections backlogged at once', () => {
    const m = new CapacityModel()
    m.update(0, [w('a', 'a', 4000, { backlogged: true }), w('b', 'b', 4000, { backlogged: true }), w('c', 'c', 1000)])
    expect(m.uplinkKbps).toBe(9000)
    // The connections only shared it: none of them is its own bottleneck.
    expect(m.peer('a').bound).toBe(false)
    // Unbacklogged windows only raise it.
    m.update(2000, [w('a', 'a', 1000), w('b', 'b', 1000), w('c', 'c', 1000)])
    expect(m.uplinkKbps).toBe(9000)
    m.update(4000, [w('a', 'a', 5000), w('b', 'b', 5000), w('c', 'c', 1000)])
    expect(m.uplinkKbps).toBe(11_000)
    // Idle connections don't vote.
    m.update(6000, [w('a', 'a', 3000, { backlogged: true }), w('b', 'b', 0, { active: false }), w('c', 'c', 0, { active: false })])
    expect(m.uplinkKbps).toBe(11_000)
    m.update(20_000, [w('a', 'a', 3000, { backlogged: true }), w('b', 'b', 0, { active: false })])
    expect(m.uplinkKbps).toBe(3000)
  })

  it('one slow connection among several: its own capacity, not the uplink', () => {
    const m = new CapacityModel()
    m.update(0, [w('a', 'a', 50_000, { backlogged: true }), w('b', 'b', 50_000, { backlogged: true })], { probe: true })
    m.update(2000, [w('a', 'a', 900, { backlogged: true, queueMs: 1400 }), w('b', 'b', 8000), w('c', 'c', 8000)])
    expect(m.peer('a')).toEqual({ kbps: 900, bound: true })
    expect(m.peer('b')).toEqual({ kbps: 50_000, bound: false })
    expect(m.uplinkKbps).toBe(100_000)
    // A headroom probe later shows it carries more now: raised.
    m.update(30_000, [w('a', 'a', 3000, { backlogged: true }), w('b', 'b', 40_000, { backlogged: true }), w('c', 'c', 40_000, { backlogged: true })], { probe: true })
    expect(m.peer('a')).toEqual({ kbps: 3000, bound: true })
    expect(m.uplinkKbps).toBe(83_000)
  })

  it('a peer is the sum of its connections', () => {
    const m = new CapacityModel()
    m.update(0, [w('a0', 'a', 9000, { backlogged: true }), w('a1', 'a', 7000), w('b0', 'b', 7000), w('b1', 'b', 7000)])
    m.update(0, [w('a0', 'a', 9000), w('a1', 'a', 7000), w('b0', 'b', 7000), w('b1', 'b', 7000)], { probe: true })
    expect(m.peer('a')).toEqual({ kbps: 16_000, bound: true })
    expect(m.conn('a0')).toEqual({ kbps: 9000, bound: true })
    m.retain(new Set(['a1']))
    expect(m.peer('a')).toEqual({ kbps: 7000, bound: false })
  })

  it('stalled connections and frozen pages are left out', () => {
    const m = new CapacityModel()
    m.update(0, [w('a', 'a', 20_000, { backlogged: true }), w('b', 'b', 20_000, { backlogged: true })], { probe: true })
    // A frozen page: everything queued, little went out. Ignored.
    m.update(2000, [w('a', 'a', 1000, { backlogged: true, queueMs: 2000 }), w('b', 'b', 1000, { backlogged: true, queueMs: 2000 })], { frozen: true })
    expect(m.uplinkKbps).toBe(40_000)
    // One connection stalled, the other backed up meanwhile: not a measurement of the uplink.
    m.update(4000, [w('a', 'a', 0, { backlogged: true, stalled: true, queueMs: 2000 }), w('b', 'b', 6000, { backlogged: true, queueMs: 1500 })])
    expect(m.uplinkKbps).toBe(40_000)
    expect(m.conn('a')?.kbps).toBe(20_000)
  })
})
