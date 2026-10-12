import { describe, expect, it } from 'vitest'
import { CapacityModel, ESTIMATE_SETTLE_MS, FROZEN_LAG_MS, SETTLE_MS, stripeKbpsFor, type ConnWindow } from '../src/session/capacity'
import { AUDIENCE_CUT_GAP_MS, AUDIENCE_LIFT_MS, AudienceCap, audienceLimit, BitrateController, DOWN_GAP_MS, JumpGate, MAX_CUT, UP_GAP_MS, PROBE_FRESH_MS, rateTarget, START_KBPS, TARGET_SHARE, upperMedian, videoKbpsForWire, ViewerSettle, type RateInputs } from '../src/session/congestion'
import { LINK_BUFFER_HIGH } from '../src/net/link'
import { PresenterRate } from '../src/session/presenterRate'
import type { PublishedStream } from '../src/session/publishedStream'

// k=4, m=1 with audio: every direct child gets one full copy, all 5 stripes.
const K = 4
const STRIPES = 5
const QUALITY = 16_000
const wireAt = (v: number) => STRIPES * stripeKbpsFor(v, K, true)
/** The best video bitrate a full-copy wire rate can carry. */
const sustainable = (wire: number) => videoKbpsForWire(wire, wireAt)
/** What the controller settles at for a given full-copy wire budget. */
const settleAt = (wire: number) => TARGET_SHARE * sustainable(wire)

/** publishedStream.ts PublishedStream.adaptBitrate: clamp to [300, chosen], 50 kbps steps. */
const applyRate = (kbps: number, chosen: number) => Math.round(Math.min(chosen, Math.max(300, kbps)) / 50) * 50

const base: RateInputs = { chosenKbps: QUALITY, audienceKbps: null, uplinkKbps: null, directChildren: 1, peerKbps: [null], wireAt }

describe('bitrate target', () => {
  it('converts wire to video kbps consistently with stripeKbpsFor', () => {
    expect(sustainable(wireAt(10_000))).toBeCloseTo(10_000, 0)
    expect(sustainable(100)).toBe(0) // less than the per-stripe constants
  })

  it('keeps the chosen quality with capacity to spare', () => {
    expect(rateTarget({ ...base, uplinkKbps: 200_000 })).toMatchObject({ kbps: QUALITY, limit: 'chosen' })
    // Nobody watching: nothing to divide by.
    expect(rateTarget({ ...base, uplinkKbps: 1000, directChildren: 0, peerKbps: [] })).toMatchObject({ kbps: QUALITY, limit: 'chosen' })
  })

  it('with viewers but nothing measured, starts no higher than START_KBPS', () => {
    expect(rateTarget(base)).toMatchObject({ kbps: START_KBPS, limit: 'unmeasured' })
    expect(rateTarget({ ...base, chosenKbps: 2000 })).toMatchObject({ kbps: 2000, limit: 'chosen' })
    const c = new BitrateController()
    expect(c.step(0, QUALITY, rateTarget(base))).toBe(START_KBPS)
    // Measured 2 s later: straight to the target, not +25% per 10 s.
    expect(c.step(2000, START_KBPS, rateTarget({ ...base, uplinkKbps: 200_000 }))).toBe(QUALITY)
    // Every direct child known (the browser's estimates), the uplink not yet: no gentle start.
    expect(rateTarget({ ...base, peerKbps: [30_000], estimated: true })).toMatchObject({ kbps: QUALITY, limit: 'chosen', estimated: true })
    expect(rateTarget({ ...base, directChildren: 2, peerKbps: [30_000, null] }).limit).toBe('unmeasured')
  })

  it('a fixed-capacity link: 85% of what it carries', () => {
    const t = rateTarget({ ...base, uplinkKbps: 14_000 })
    expect(t.limit).toBe('uplink')
    expect(t.kbps).toBeCloseTo(settleAt(14_000))
  })

  it('a shared uplink: divided among the direct children', () => {
    const t = rateTarget({ ...base, uplinkKbps: 20_000, directChildren: 4, peerKbps: [null, null, null, null] })
    expect(t).toMatchObject({ limit: 'uplink', uplinkPerChildKbps: 5000 })
    expect(t.kbps).toBeCloseTo(settleAt(5000))
  })

  it('one slow viewer: the median protects the others', () => {
    const t = rateTarget({ ...base, uplinkKbps: 100_000, directChildren: 3, peerKbps: [null, 2000, null] })
    expect(t).toMatchObject({ kbps: QUALITY, limit: 'chosen', medianPeerKbps: null })
    // One of two isn't the median either.
    expect(rateTarget({ ...base, uplinkKbps: 100_000, directChildren: 2, peerKbps: [2000, null] }).limit).toBe('chosen')
  })

  it('most viewers slow: their median', () => {
    const t = rateTarget({ ...base, uplinkKbps: 100_000, directChildren: 3, peerKbps: [3000, 4000, null] })
    expect(t).toMatchObject({ limit: 'viewers', medianPeerKbps: 4000 })
    expect(t.kbps).toBeCloseTo(settleAt(4000))
    expect(upperMedian([5, 1, 3, 2])).toBe(3)
  })

  it("with the browser's estimates: the children's median, not the uplink's share (their mean), unless the up= shaper binds", () => {
    // 3 children at 20, 20 and 1.5 Mbps: the estimates' sum per child (13.8 Mbps) is their mean.
    const i = { ...base, uplinkKbps: 41_500, directChildren: 3, peerKbps: [20_000, 20_000, 1500], estimated: true }
    expect(rateTarget(i)).toMatchObject({ limit: 'viewers', medianPeerKbps: 20_000, estimated: true })
    expect(rateTarget(i).kbps).toBeCloseTo(settleAt(20_000))
    // Measured capacities: the share binds as before.
    expect(rateTarget({ ...i, estimated: false }).limit).toBe('uplink')
    // A 6 Mbps shaper: 2 Mbps each, followed carefully (not an estimate).
    const capped = rateTarget({ ...i, uplinkCapKbps: 6000 })
    expect(capped).toMatchObject({ limit: 'uplink', estimated: false })
    expect(capped.kbps).toBeCloseTo(settleAt(2000))
  })

  it('never above what the audience can relay', () => {
    expect(rateTarget({ ...base, uplinkKbps: 100_000, audienceKbps: 6000 })).toMatchObject({ kbps: 6000, limit: 'audience' })
  })
})

describe('bitrate pacing', () => {
  const t = (kbps: number, limit: 'uplink' | 'chosen' | 'viewers' = 'uplink', estimated = false) => ({ kbps, limit, uplinkPerChildKbps: null, medianPeerKbps: null, estimated })

  it('down at once, at most every 4 s; up by at most 25% per 10 s; small changes ignored', () => {
    const c = new BitrateController()
    expect(c.step(0, 16_000, t(8000))).toBe(8000)
    expect(c.step(2000, 8000, t(4000))).toBeNull()
    expect(c.step(DOWN_GAP_MS, 8000, t(4000))).toBe(4000)
    // Up: not within 10 s of a cut, then +25% at most, then again 10 s later.
    expect(c.step(10_000, 4000, t(16_000, 'chosen'))).toBeNull()
    expect(c.step(14_000, 4000, t(16_000, 'chosen'))).toBe(5000)
    expect(c.step(20_000, 5000, t(16_000, 'chosen'))).toBeNull()
    expect(c.step(24_000, 5000, t(16_000, 'chosen'))).toBe(6250)
    // Within 5%: noise.
    expect(c.step(40_000, 6250, t(6400))).toBeNull()
    expect(c.step(40_000, 6250, t(6000))).toBeNull()
    // But back to the chosen quality from just below it.
    expect(c.step(40_000, 15_800, t(16_000, 'chosen'))).toBe(16_000)
  })

  it('a cut is at most by half, unless capacity just fell at once', () => {
    const c = new BitrateController()
    expect(MAX_CUT).toBe(0.5)
    expect(c.step(0, 16_000, t(2000))).toBe(8000)
    expect(c.step(DOWN_GAP_MS, 8000, t(2000))).toBe(4000)
    // A fast drop since the last cut (~6 s of evidence already): all the way.
    expect(c.step(2 * DOWN_GAP_MS, 4000, t(1000), { fastDropAt: DOWN_GAP_MS + 1 })).toBe(1000)
    // The same fast drop doesn't steepen the next cut.
    expect(c.step(3 * DOWN_GAP_MS, 1000, t(300), { fastDropAt: DOWN_GAP_MS + 1 })).toBe(500)
  })

  it("the browser's estimate falling (20 → 3 Mbps): straight down to its target in one step", () => {
    const c = new BitrateController()
    const low = settleAt(3000)
    expect(c.step(0, 13_000, t(low, 'viewers', true))).toBe(low)
    // At most one cut per DOWN_GAP_MS still.
    expect(c.step(2000, low, t(low / 2, 'viewers', true))).toBeNull()
    expect(c.step(DOWN_GAP_MS, low, t(low / 2, 'viewers', true))).toBe(low / 2)
  })

  it("the browser's estimate rising: straight up to its target, not 25% per 10 s, and soon after a cut", () => {
    const c = new BitrateController()
    expect(c.step(0, 8000, t(4000, 'viewers', true))).toBe(4000)
    // Within DOWN_GAP_MS of the cut: held (a dip and its recovery aren't two changes).
    expect(c.step(2000, 4000, t(12_000, 'viewers', true))).toBeNull()
    expect(c.step(DOWN_GAP_MS, 4000, t(12_000, 'viewers', true))).toBe(12_000)
    expect(DOWN_GAP_MS).toBeLessThan(UP_GAP_MS)
    // Then again DOWN_GAP_MS later, all the way to the chosen quality; under 5% is still noise.
    expect(c.step(DOWN_GAP_MS + 2000, 12_000, t(16_000, 'chosen', true))).toBeNull()
    expect(c.step(2 * DOWN_GAP_MS, 12_000, t(16_000, 'chosen', true))).toBe(16_000)
    expect(c.step(4 * DOWN_GAP_MS, 15_000, t(15_500, 'viewers', true))).toBeNull()
  })

  it('a jump: straight to the target, then the usual pacing', () => {
    const c = new BitrateController()
    expect(c.jump(0, t(20_000, 'chosen'))).toBe(20_000)
    expect(c.step(2000, 20_000, t(21_000, 'uplink'))).toBeNull()
  })
})

describe('jump gate', () => {
  const at = (g: JumpGate, now: number, o: Partial<Parameters<JumpGate['step']>[1]> = {}) =>
    g.step(now, { ceilingKbps: 20_000, currentKbps: 7000, targetKbps: 20_000, probedAt: -Infinity, children: true, ...o })

  it('a raised quality: at once with a recent probe, else once a probe confirms it', () => {
    const g = new JumpGate()
    at(g, 0, { ceilingKbps: 7000, targetKbps: 7000 }) // streaming at 7 Mbps
    // Raised, with a probe 20 s ago: straight there.
    expect(at(g, 100_000, { probedAt: 80_000 })).toBe(true)
    // Raised again, the last probe too old: wait, and ask for one.
    expect(at(g, 200_000, { ceilingKbps: 28_000, currentKbps: 20_000, targetKbps: 28_000, probedAt: 200_000 - PROBE_FRESH_MS - 1 })).toBe(false)
    expect(g.probeWanted).toBe(true)
    expect(at(g, 202_000, { ceilingKbps: 28_000, currentKbps: 20_000, targetKbps: 28_000, probedAt: 201_000 })).toBe(true)
    expect(g.probeWanted).toBe(false)
  })

  it("a probe that shows the uplink can't carry the raise ends it without a jump", () => {
    const g = new JumpGate()
    at(g, 0, { ceilingKbps: 7000, targetKbps: 7000 })
    expect(at(g, 100_000)).toBe(false)
    expect(at(g, 102_000, { targetKbps: 9000, currentKbps: 9000, probedAt: 101_000 })).toBe(false)
    expect(at(g, 104_000, { targetKbps: 12_000, currentKbps: 9000, probedAt: 101_000 })).toBe(false)
  })

  it('no children: at once', () => {
    const g = new JumpGate()
    at(g, 0, { ceilingKbps: 7000, targetKbps: 7000, children: false })
    expect(at(g, 1000, { children: false })).toBe(true)
  })

  it('after a cut, a later probe that shows capacity back lifts it at once', () => {
    const g = new JumpGate()
    at(g, 0, { currentKbps: 20_000, probedAt: 0 })
    g.cut(10_000)
    expect(at(g, 12_000, { currentKbps: 10_000, probedAt: 0 })).toBe(false)
    expect(g.probeWanted).toBe(false) // the usual cadence probes, no extra one
    expect(at(g, 16_000, { currentKbps: 10_000, probedAt: 15_000 })).toBe(true)
  })
})

/**
 * A presenter feeding `children` viewers one full copy each, simulated in 100 ms ticks. Viewer i's
 * connection carries at most `link(t)[i]` kbps and all of them share the uplink's `uplink(t)` kbps
 * (fair shares). Each connection has an uplink queue in front of a 64 KiB send buffer; fragments
 * waiting longer than 1.5 s are dropped. Every 2 s the estimator (CapacityModel) sees one window
 * per connection, and the controller moves the bitrate, as PeerSession does. While no connection is
 * backlogged, a 1.5 s headroom probe runs every 30 s: background bytes on every connection, after
 * media.
 */
function simulate(o: {
  seconds: number
  uplink: (t: number) => number
  link: (t: number, i: number) => number
  children?: number
  /** A connection stalls (delivers nothing) at time t. */
  stalled?: (t: number, i: number) => boolean
  /** The page is frozen at time t (the windows say so). */
  frozen?: (t: number) => boolean
  audienceKbps?: number
}) {
  const TICK = 0.1
  const n = o.children ?? 1
  const bufKbit = (LINK_BUFFER_HIGH * 8) / 1000
  const model = new CapacityModel()
  const ctl = new BitrateController()
  let v = QUALITY
  const links = Array.from({ length: n }, () => ({ q: 0, buf: 0, delivered: 0, busy: 0, stalledInWin: false }))
  let lastProbe = -Infinity
  let probe: { until: number; delivered: number[] } | null = null
  let backloggedLast = false
  let frozenInWin = false
  const rates: { t: number; kbps: number }[] = []
  let changes = 0
  for (let i = 1; i <= o.seconds / TICK; i++) {
    const t = i * TICK
    const offered = wireAt(v) * TICK
    // Probing: every 30 s (first at 1 s) while nothing is backlogged.
    if (!probe && !backloggedLast && (lastProbe === -Infinity ? t >= 1 : t - lastProbe >= 30)) {
      probe = { until: t + 1.5 - TICK, delivered: links.map(() => 0) }
      lastProbe = t
    }
    // Media into the queues and on into the send buffers.
    for (const l of links) {
      l.q += offered
      const move = Math.min(l.q, bufKbit - l.buf)
      l.q -= move
      l.buf += move
    }
    // Fair shares of the uplink, each connection capped by its own rate: media first, then probes.
    let room = o.uplink(t) * TICK
    const cap = links.map((_, j) => (o.stalled?.(t, j) ? 0 : o.link(t, j) * TICK))
    const fill = (demand: number[]) => {
      const got = demand.map(() => 0)
      let open = demand.map((d, j) => (d > 0 ? j : -1)).filter((j) => j >= 0)
      while (open.length && room > 1e-9) {
        const share = room / open.length
        for (const j of open) {
          const take = Math.min(share, demand[j] - got[j])
          got[j] += take
          room -= take
        }
        open = open.filter((j) => demand[j] - got[j] > 1e-9)
      }
      return got
    }
    // The buffer refills on buffer-low events as it drains: the queue goes out too, within the tick.
    const media = fill(links.map((l, j) => Math.min(l.buf + l.q, cap[j])))
    const bg = probe ? fill(links.map((_, j) => cap[j] - media[j])) : links.map(() => 0)
    links.forEach((l, j) => {
      const fromBuf = Math.min(l.buf, media[j])
      l.buf -= fromBuf
      l.q -= media[j] - fromBuf
      l.delivered += media[j] + bg[j]
      if (probe) probe.delivered[j] += media[j] + bg[j]
      const move = Math.min(l.q, bufKbit - l.buf)
      l.q -= move
      l.buf += move
      // Fragments past their deadline (about 1.5 s of the offered rate) are dropped.
      l.q = Math.min(l.q, (offered / TICK) * 1.5)
      if (l.q > 0) l.busy += TICK
      if (o.stalled?.(t, j)) l.stalledInWin = true
    })
    if (o.frozen?.(t)) frozenInWin = true
    if (probe && t >= probe.until - 1e-9) {
      const pw: ConnWindow[] = probe.delivered.map((d, j) => ({ id: j, peer: `p${j}`, kbps: d / 1.5, active: true, backlogged: true, stalled: false, queueMs: 0 }))
      model.update(t * 1000, pw, { probe: true })
      probe = null
    }
    if (i % 20 === 0) {
      const windows: ConnWindow[] = links.map((l, j) => ({
        id: j,
        peer: `p${j}`,
        kbps: l.delivered / 2,
        active: true,
        backlogged: l.busy >= 1.8 - 1e-9,
        stalled: l.stalledInWin,
        queueMs: (l.q / (offered / TICK)) * 1000,
      }))
      model.update(t * 1000, windows, { frozen: frozenInWin })
      backloggedLast = windows.some((w) => w.backlogged)
      for (const l of links) Object.assign(l, { delivered: 0, busy: 0, stalledInWin: false })
      frozenInWin = false
      const peerKbps = links.map((_, j) => {
        const p = model.peer(`p${j}`)
        return p.bound ? p.kbps : null
      })
      const target = rateTarget({ chosenKbps: QUALITY, audienceKbps: o.audienceKbps ?? null, uplinkKbps: model.uplinkKbps, directChildren: n, peerKbps, wireAt })
      const next = ctl.step(t * 1000, v, target, { fastDropAt: model.fastDropAt })
      if (next !== null) {
        const r = applyRate(next, QUALITY)
        if (r !== v) changes++
        v = r
      }
      rates.push({ t, kbps: v })
    }
  }
  return { rates, changes, model }
}

const between = (rates: { t: number; kbps: number }[], from: number, to: number) => rates.filter((r) => r.t > from && r.t <= to).map((r) => r.kbps)
/** After the start: the first window may come before the first probe measured the uplink (START_KBPS). */
const afterStart = (rates: { t: number; kbps: number }[]) => rates.filter((r) => r.t > 4)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const range = (xs: number[]) => `${Math.round(mean(xs))} [${Math.min(...xs)}..${Math.max(...xs)}]`

describe('estimator and controller, end to end', () => {
  it('settles near what one 14 Mbps connection carries, without 16 → 8 oscillation', () => {
    const max = sustainable(14_000) // ≈ 10.2 Mbps of video
    const r = simulate({ seconds: 180, uplink: () => 100_000, link: () => 14_000 })
    const settled = between(r.rates, 20, 180)
    console.log(`one connection at 14 Mbps (sustainable ${Math.round(max)} kbps): ${range(settled)}, ${r.changes} changes`)
    for (const x of settled) {
      expect(x).toBeGreaterThanOrEqual(max * 0.8)
      expect(x).toBeLessThanOrEqual(max * 0.95)
    }
    expect(r.changes).toBeLessThanOrEqual(6)
  })

  it('a shared uplink with several children: its fair share each', () => {
    const r = simulate({ seconds: 120, uplink: () => 20_000, link: () => 50_000, children: 4 })
    const settled = between(r.rates, 20, 120)
    const max = sustainable(5000)
    console.log(`4 children on a 20 Mbps uplink (sustainable ${Math.round(max)} kbps each): ${range(settled)}, ${r.changes} changes`)
    for (const x of settled) {
      expect(x).toBeGreaterThanOrEqual(max * 0.8)
      expect(x).toBeLessThanOrEqual(max * 0.95)
    }
  })

  it('one slow viewer does not throttle the others', () => {
    const r = simulate({ seconds: 90, uplink: () => 200_000, link: (_, i) => (i === 2 ? 3000 : 50_000), children: 3 })
    console.log(`3 children, one at 3 Mbps: ${range(r.rates.map((x) => x.kbps))}; slow peer ${JSON.stringify(r.model.peer('p2'))}`)
    expect(afterStart(r.rates).every((x) => x.kbps === QUALITY)).toBe(true)
    expect(r.model.peer('p2').bound).toBe(true)
    expect(r.model.peer('p2').kbps).toBeLessThan(3500)
  })

  it('all viewers slow: settles at what their connections carry', () => {
    const r = simulate({ seconds: 120, uplink: () => 200_000, link: () => 6000, children: 3 })
    const settled = between(r.rates, 20, 120)
    const max = sustainable(6000)
    console.log(`3 children at 6 Mbps each (sustainable ${Math.round(max)} kbps): ${range(settled)}`)
    for (const x of settled) {
      expect(x).toBeGreaterThanOrEqual(max * 0.8)
      expect(x).toBeLessThanOrEqual(max * 0.95)
    }
  })

  it('recovers to the chosen quality when capacity rises', () => {
    const r = simulate({ seconds: 300, uplink: () => 100_000, link: (t) => (t < 120 ? 14_000 : 40_000) })
    const reachedAt = r.rates.find((x) => x.t > 120 && x.kbps === QUALITY)?.t
    console.log(`14 → 40 Mbps at 120 s: back to 16 Mbps at ${reachedAt} s`)
    expect(reachedAt).toBeDefined()
    // The next headroom probe (≤ 30 s) sees it, then +25% per 10 s.
    expect(reachedAt!).toBeLessThan(120 + 60)
    expect(between(r.rates, 200, 300).every((x) => x === QUALITY)).toBe(true)
  })

  it('cuts fast when capacity falls', () => {
    const r = simulate({ seconds: 120, uplink: () => 100_000, link: (t) => (t < 60 ? 40_000 : 3000) })
    const at = (t: number) => r.rates.find((x) => x.t >= t)!.kbps
    expect(at(58)).toBe(QUALITY)
    const max = sustainable(3000)
    // Once FAST_DROP_WINDOWS windows in a row show it (about 6 s), and the next 2 s window.
    expect(at(68)).toBeLessThanOrEqual(max)
    const settled = between(r.rates, 70, 120)
    console.log(`40 → 3 Mbps at 60 s (sustainable ${Math.round(max)} kbps): at 68 s ${at(68)}, then ${range(settled)}`)
    for (const x of settled) {
      expect(x).toBeLessThanOrEqual(max)
      expect(x).toBeGreaterThanOrEqual(max * 0.7)
    }
  })

  it('rides out a burst: a link slow for one window (a keyframe, a retransmission) is not a fall', () => {
    const r = simulate({ seconds: 120, uplink: () => 100_000, link: (t) => (t >= 60 && t < 62 ? 3000 : 40_000) })
    console.log(`40 Mbps, 3 Mbps for 2 s at 60 s: ${range(between(r.rates, 50, 120))}`)
    expect(afterStart(r.rates).every((x) => x.kbps === QUALITY)).toBe(true)
  })

  it('ignores stalls: a connection that stops for a second every 10 s is not a slow uplink', () => {
    const r = simulate({ seconds: 120, uplink: () => 100_000, link: () => 60_000, children: 2, stalled: (t, i) => i === 0 && t % 10 < 1 })
    expect(afterStart(r.rates).every((x) => x.kbps === QUALITY)).toBe(true)
  })

  it('ignores windows in which the page froze', () => {
    // A frozen page sends nothing while it is frozen: the uplink looks slow and backlogged.
    const r = simulate({ seconds: 120, uplink: (t) => (t > 30 && t % 12 < 1.5 ? 0 : 100_000), link: () => 60_000, frozen: (t) => t > 30 && t % 12 < 1.5 })
    expect(FROZEN_LAG_MS).toBeLessThan(1500)
    expect(afterStart(r.rates).every((x) => x.kbps === QUALITY)).toBe(true)
  })

  it('never climbs above what the audience can relay', () => {
    const r = simulate({ seconds: 60, uplink: () => 100_000, link: () => 100_000, audienceKbps: 7000 })
    expect(Math.max(...between(r.rates, 5, 60))).toBe(7000)
  })
})

describe('auto quality (lower automatically)', () => {
  /**
   * PeerSession every 2 s: the Auto quality cap, then the bitrate target and controller, with
   * plenty of uplink. `limitedAt(t)` is the publisher's feasibility verdict at t seconds.
   */
  function run(seconds: number, auto: boolean, limitedAt: (t: number) => { feasibleKbps: number } | null) {
    const cap = new AudienceCap()
    const ctl = new BitrateController()
    let kbps = QUALITY
    const rates: number[] = []
    for (let t = 0; t <= seconds; t += 2) {
      const now = t * 1000
      const limited = limitedAt(t)
      cap.step(now, auto, limited, QUALITY)
      const target = rateTarget({ ...base, uplinkKbps: 1e6, audienceKbps: audienceLimit(auto ? cap.kbps : null, limited, kbps) })
      const next = ctl.step(now, kbps, target)
      if (next !== null) kbps = applyRate(next, QUALITY)
      rates.push(kbps)
    }
    return rates
  }
  const at = (rates: number[], t: number) => rates[t / 2]

  it('cuts to what the audience carries, and returns to the chosen quality once it carries more', () => {
    // Short from 10 s to 60 s (a slow viewer), then fine again (it left).
    const rates = run(300, true, (t) => (t >= 10 && t < 60 ? { feasibleKbps: 4000 } : null))
    expect(at(rates, 8)).toBe(QUALITY)
    expect(at(rates, 20)).toBe(4000)
    expect(at(rates, 58)).toBe(4000)
    // Held for AUDIENCE_LIFT_MS after the audience recovers, then back up at the controller's pace.
    expect(at(rates, 60 + AUDIENCE_LIFT_MS / 1000 - 2)).toBe(4000)
    expect(at(rates, 300)).toBe(QUALITY)
  })

  it('without Auto quality it never cuts, only stops climbing', () => {
    const rates = run(60, false, (t) => (t >= 10 ? { feasibleKbps: 4000 } : null))
    expect(rates.every((r) => r === QUALITY)).toBe(true)
  })

  it('cuts at most once per gap, each time to the new verdict', () => {
    const cap = new AudienceCap()
    expect(cap.step(0, true, { feasibleKbps: 8000 }, QUALITY)).toBe(8000)
    expect(cap.step(2000, true, { feasibleKbps: 6000 }, QUALITY)).toBe(8000)
    expect(cap.step(AUDIENCE_CUT_GAP_MS, true, { feasibleKbps: 6000 }, QUALITY)).toBe(6000)
    // A verdict above the cap, or the chosen quality, changes nothing.
    expect(cap.step(2 * AUDIENCE_CUT_GAP_MS, true, { feasibleKbps: 9000 }, QUALITY)).toBe(6000)
    expect(new AudienceCap().step(0, true, { feasibleKbps: QUALITY + 1000 }, QUALITY)).toBeNull()
    // Turning Auto quality off drops the cap at once.
    expect(cap.step(2 * AUDIENCE_CUT_GAP_MS + 2000, false, { feasibleKbps: 6000 }, QUALITY)).toBeNull()
  })

  it('a short dip in the audience does not lift the cap', () => {
    const cap = new AudienceCap()
    cap.step(0, true, { feasibleKbps: 5000 }, QUALITY)
    cap.step(10_000, true, null, QUALITY)
    cap.step(20_000, true, { feasibleKbps: 5000 }, QUALITY)
    expect(cap.step(20_000 + AUDIENCE_LIFT_MS - 1, true, null, QUALITY)).toBe(5000)
  })
})

describe('viewer settle', () => {
  it("a direct child's capacity counts only once it has been fed SETTLE_MS", () => {
    const v = new ViewerSettle()
    v.update(0, ['a'])
    v.update(10_000, ['a', 'b'])
    expect(v.settled(SETTLE_MS - 1, 'a')).toBe(false)
    expect(v.settled(SETTLE_MS, 'a')).toBe(true)
    expect(v.settled(SETTLE_MS, 'b')).toBe(false)
    expect(v.settled(SETTLE_MS, 'c')).toBe(false)
    // No longer fed: it starts over when it comes back.
    v.update(SETTLE_MS, ['b'])
    v.update(SETTLE_MS + 2000, ['a', 'b'])
    expect(v.settled(SETTLE_MS + 2000, 'a')).toBe(false)
    expect(v.settled(10_000 + SETTLE_MS, 'b')).toBe(true)
  })
})

describe("the browser's estimates, end to end (PresenterRate)", () => {
  /** A presenter's stream feeding every stripe to each of `children` (PublishedStream, as presenterRate.ts reads it). */
  function stream(children: string[], kbps = QUALITY): PublishedStream {
    const parents = Object.fromEntries(children.map((c) => [c, Array(STRIPES).fill('me')]))
    const full = { stripes: STRIPES, k: K, withAudio: true, kbps, limited: null, subscribers: new Set(children), topology: { parents } }
    return { full, ceilingKbps: QUALITY, adaptBitrate: (v: number) => (full.kbps = applyRate(v, QUALITY)) } as unknown as PublishedStream
  }
  /** Every 2 s from `from` to `to` (ms): each viewer's estimate polled, then a window. */
  function run(rate: PresenterRate, capacity: CapacityModel, s: PublishedStream, from: number, to: number, est: (t: number, peer: string) => number) {
    const log: { t: number; kbps: number }[] = []
    for (let t = from; t <= to; t += 2000) {
      for (const peer of Object.keys(s.full!.topology.parents)) capacity.setKnown(`${peer}-conn`, peer, est(t, peer), t)
      rate.adapt(s, t)
      log.push({ t, kbps: s.full!.kbps })
    }
    return log
  }

  it('leaves START_KBPS within a few seconds once the estimates are in, not after 30', () => {
    const capacity = new CapacityModel()
    // Connections that would still be settling without an estimate: it doesn't matter with one.
    const rate = new PresenterRate('me', capacity, () => false)
    const s = stream(['v'], START_KBPS)
    const log = run(rate, capacity, s, 0, 10_000, (t) => (t === 0 ? 2500 : 30_000))
    expect(log[0].kbps).toBe(START_KBPS)
    const leftAt = log.find((x) => x.kbps !== START_KBPS)!.t
    expect(leftAt).toBeLessThanOrEqual(ESTIMATE_SETTLE_MS + 2000)
    expect(leftAt).toBeLessThan(SETTLE_MS)
    expect(s.full!.kbps).toBe(QUALITY)
  })

  it('a slow viewer of three: its estimate falling cuts neither the uplink nor the bitrate below the median', () => {
    const capacity = new CapacityModel()
    const rate = new PresenterRate('me', capacity, () => true)
    const s = stream(['a', 'b', 'c'])
    const est = (t: number, p: string) => (p === 'a' && t >= 20_000 ? 1500 : p === 'b' && t >= 20_000 ? 18_000 : 20_000)
    run(rate, capacity, s, 0, 18_000, est)
    const before = s.full!.kbps
    // Every carrier backlogged by its own bucket: once taken as a full shared uplink.
    const backed = (t: number) => ['a', 'b', 'c'].map((p): ConnWindow => ({ id: `${p}-conn`, peer: p, kbps: est(t, p), active: true, backlogged: true, stalled: false, queueMs: 2000 }))
    for (let t = 20_000; t <= 40_000; t += 2000) {
      capacity.update(t, backed(t))
      run(rate, capacity, s, t, t, est)
    }
    expect(capacity.uplinkKbps).toBe(39_500)
    expect(rate.target).toMatchObject({ limit: 'viewers', medianPeerKbps: 18_000 })
    expect(s.full!.kbps).toBe(applyRate(settleAt(18_000), QUALITY))
    expect(before).toBe(applyRate(settleAt(20_000), QUALITY))
  })

  it("a 20 → 3 Mbps estimate cuts to its target at the next window, and recovers as fast", () => {
    const capacity = new CapacityModel()
    const rate = new PresenterRate('me', capacity, () => true)
    const s = stream(['v'])
    const est = (t: number) => (t < 30_000 || t >= 50_000 ? 20_000 : 3000)
    const log = run(rate, capacity, s, 0, 70_000, est)
    const at = (t: number) => log.find((x) => x.t === t)!.kbps
    expect(at(28_000)).toBe(applyRate(settleAt(20_000), QUALITY))
    expect(at(30_000)).toBe(applyRate(settleAt(3000), QUALITY))
    // Back up in one step (within DOWN_GAP_MS of the change), not 25% per 10 s.
    expect(at(50_000 + DOWN_GAP_MS)).toBe(applyRate(settleAt(20_000), QUALITY))
  })

  it('a child without an estimate still waits out SETTLE_MS (ViewerSettle)', () => {
    const capacity = new CapacityModel()
    // The connection to v measured itself its own bottleneck: no estimate.
    for (const t of [0, 2000, 4000]) capacity.update(t, [{ id: 'v0', peer: 'v', kbps: 8000, active: true, backlogged: true, stalled: false, queueMs: 2000 }, { id: 'w0', peer: 'w', kbps: 8000, active: true, backlogged: false, stalled: false, queueMs: 0 }, { id: 'x0', peer: 'x', kbps: 8000, active: true, backlogged: false, stalled: false, queueMs: 0 }])
    expect(capacity.peer('v')).toEqual({ kbps: 8000, bound: true, estimated: false })
    const rate = new PresenterRate('me', capacity, () => true)
    const s = stream(['v'])
    rate.adapt(s, 0)
    expect(rate.target!.medianPeerKbps).toBeNull()
    rate.adapt(s, SETTLE_MS)
    expect(rate.target).toMatchObject({ limit: 'viewers', medianPeerKbps: 8000, estimated: false })
  })
})
