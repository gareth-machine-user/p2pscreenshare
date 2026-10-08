import { describe, expect, it } from 'vitest'
import { CapacityModel, FROZEN_LAG_MS, stripeKbpsFor, type ConnWindow } from '../src/session/capacity'
import { AUDIENCE_CUT_GAP_MS, AUDIENCE_LIFT_MS, AudienceCap, audienceLimit, BitrateController, DOWN_GAP_MS, rateTarget, TARGET_SHARE, upperMedian, videoKbpsForWire, type RateInputs } from '../src/session/congestion'
import { LINK_BUFFER_HIGH } from '../src/net/link'

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

  it('keeps the chosen quality with nothing measured, or capacity to spare', () => {
    expect(rateTarget(base)).toMatchObject({ kbps: QUALITY, limit: 'chosen' })
    expect(rateTarget({ ...base, uplinkKbps: 200_000 })).toMatchObject({ kbps: QUALITY, limit: 'chosen' })
    // Nobody watching: nothing to divide by.
    expect(rateTarget({ ...base, uplinkKbps: 1000, directChildren: 0, peerKbps: [] })).toMatchObject({ kbps: QUALITY, limit: 'chosen' })
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

  it('never above what the audience can relay', () => {
    expect(rateTarget({ ...base, uplinkKbps: 100_000, audienceKbps: 6000 })).toMatchObject({ kbps: 6000, limit: 'audience' })
  })
})

describe('bitrate pacing', () => {
  const t = (kbps: number, limit: 'uplink' | 'chosen' = 'uplink') => ({ kbps, limit, uplinkPerChildKbps: null, medianPeerKbps: null })

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
      const next = ctl.step(t * 1000, v, target)
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
    expect(r.rates.every((x) => x.kbps === QUALITY)).toBe(true)
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
    // Within one or two windows of the fall.
    expect(at(64)).toBeLessThanOrEqual(max)
    const settled = between(r.rates, 70, 120)
    console.log(`40 → 3 Mbps at 60 s (sustainable ${Math.round(max)} kbps): at 64 s ${at(64)}, then ${range(settled)}`)
    for (const x of settled) {
      expect(x).toBeLessThanOrEqual(max)
      expect(x).toBeGreaterThanOrEqual(max * 0.7)
    }
  })

  it('ignores stalls: a connection that stops for a second every 10 s is not a slow uplink', () => {
    const r = simulate({ seconds: 120, uplink: () => 100_000, link: () => 60_000, children: 2, stalled: (t, i) => i === 0 && t % 10 < 1 })
    expect(r.rates.every((x) => x.kbps === QUALITY)).toBe(true)
  })

  it('ignores windows in which the page froze', () => {
    // A frozen page sends nothing while it is frozen: the uplink looks slow and backlogged.
    const r = simulate({ seconds: 120, uplink: (t) => (t > 30 && t % 12 < 1.5 ? 0 : 100_000), link: () => 60_000, frozen: (t) => t > 30 && t % 12 < 1.5 })
    expect(FROZEN_LAG_MS).toBeLessThan(1500)
    expect(r.rates.every((x) => x.kbps === QUALITY)).toBe(true)
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
