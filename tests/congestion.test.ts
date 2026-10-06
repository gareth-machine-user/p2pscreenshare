import { describe, expect, it } from 'vitest'
import { stripeKbpsFor, uplinkIsFull } from '../src/session/capacity'
import { CongestionController, videoKbpsForWire, type CongestionSample } from '../src/session/congestion'
import { LINK_BUFFER_HIGH } from '../src/net/link'

// A presenter with one viewer: k=4, m=1, audio, so the presenter sends all 5 stripes over one
// WebRTC connection whose congestion control tops out at `ceiling` (wire kbps).
const K = 4
const COPIES = 5
const QUALITY = 16_000
const ownWire = (v: number) => COPIES * stripeKbpsFor(v, K, true)
/** The best video bitrate a wire ceiling can carry (no other traffic). */
const sustainable = (wire: number) => videoKbpsForWire(wire, ownWire)

/** publisher.ts PublishedStream.adaptBitrate: clamp to [300, ceiling], 50 kbps steps. */
const applyRate = (kbps: number, ceiling: number) => Math.round(Math.min(ceiling, Math.max(300, kbps)) / 50) * 50

/** The policy this replaced (PeerSession.adaptBitrate before congestion.ts), for comparison. */
class OldPolicy {
  private lastDown = -Infinity
  private lastUp = -Infinity
  private cleanSince: number | null = null
  sample(s: CongestionSample): { kbps: number } | null {
    if (s.full) {
      this.cleanSince = null
      if (s.now - this.lastDown >= 4000 && s.currentKbps > 300) {
        this.lastDown = s.now
        const severe = s.dropsPerS > 50 || s.queueMs > 1600
        return { kbps: s.currentKbps * (severe ? 0.5 : 0.75) }
      }
      return null
    }
    this.cleanSince ??= s.now
    if (s.currentKbps < s.maxKbps && s.now - this.cleanSince >= 5000 && s.now - this.lastUp >= 5000) {
      this.lastUp = s.now
      return { kbps: Math.min(s.maxKbps, s.currentKbps * 1.25) }
    }
    return null
  }
}

interface Policy {
  sample(s: CongestionSample): { kbps: number } | null
}

/**
 * One link, simulated in 100 ms ticks: what the stream (plus `other` kbps) offers goes through the
 * data channel's send buffer (LINK_BUFFER_HIGH, invisible to queueing stats) into the uplink's
 * queue; the link drains `ceiling(t)` kbps. Fragments queued past ~1.5 s (a mix of the per-layer
 * deadlines) are dropped. Every 2 s the policy sees a sample, as PeerSession.adaptBitrate does,
 * with uplinkIsFull's single-link test (the probe measured the same connection: probe ≈ ceiling).
 */
function simulate(policy: Policy, ceiling: (t: number) => number, seconds: number, other = 0) {
  const TICK = 0.1
  const bufferKbit = (LINK_BUFFER_HIGH * 8) / 1000
  const FRAGMENT_KBIT = 1.1 * 8
  let v = QUALITY
  let backlog = 0 // kbit, send buffer + app queue
  let win = { sent: 0, drops: 0, qSum: 0, n: 0 }
  const rates: { t: number; kbps: number }[] = []
  let changes = 0
  for (let i = 1; i <= seconds / TICK; i++) {
    const t = i * TICK
    const c = ceiling(t)
    backlog += (ownWire(v) + other) * TICK
    const sent = Math.min(backlog, c * TICK)
    backlog -= sent
    const appQueue = Math.max(0, backlog - bufferKbit)
    const maxQueue = 1.5 * c
    if (appQueue > maxQueue) {
      win.drops += (appQueue - maxQueue) / FRAGMENT_KBIT
      backlog -= appQueue - maxQueue
    }
    win.sent += sent
    win.qSum += (Math.min(appQueue, maxQueue) / c) * 1000
    win.n++
    if (i % 20 === 0) {
      const sentKbps = win.sent / 2
      const dropsPerS = win.drops / 2
      const queueMs = win.qSum / win.n
      const congested = dropsPerS > 2 || queueMs > 800
      const full = !!uplinkIsFull([{ congested }], sentKbps, c, 0.5, 0.7)
      const d = policy.sample({ now: t * 1000, full, sentKbps, currentKbps: v, maxKbps: QUALITY, dropsPerS, queueMs, ownWireKbpsAt: ownWire })
      if (d) {
        const next = applyRate(d.kbps, QUALITY)
        if (next !== v) changes++
        v = next
      }
      rates.push({ t, kbps: v })
      win = { sent: 0, drops: 0, qSum: 0, n: 0 }
    }
  }
  return { rates, changes }
}

const between = (rates: { t: number; kbps: number }[], from: number, to: number) => rates.filter((r) => r.t > from && r.t <= to).map((r) => r.kbps)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export { simulate, OldPolicy }
describe('congestion controller', () => {
  it('converts wire to video kbps consistently with stripeKbpsFor', () => {
    expect(ownWire(QUALITY)).toBeCloseTo(21_555, 0)
    expect(sustainable(ownWire(10_000))).toBeCloseTo(10_000, 0)
    expect(sustainable(100)).toBe(0) // less than the per-stripe constants
  })

  it('settles near the rate one 14 Mbps connection carries, without 16 → 8 oscillation', () => {
    const max = sustainable(14_000) // ≈ 10.2 Mbps of video
    const neu = simulate(new CongestionController(), () => 14_000, 180)
    const old = simulate(new OldPolicy(), () => 14_000, 180)
    const settled = between(neu.rates, 40, 180)
    const oldSettled = between(old.rates, 40, 180)
    // Documentation: the numbers this test pins down.
    console.log(
      `ceiling 14 Mbps wire (max ${Math.round(max)} kbps video): new mean ${Math.round(mean(settled))} [${Math.min(...settled)}..${Math.max(...settled)}] ` +
        `${neu.changes} changes; old mean ${Math.round(mean(oldSettled))} [${Math.min(...oldSettled)}..${Math.max(...oldSettled)}] ${old.changes} changes`,
    )
    for (const r of settled) {
      expect(r).toBeGreaterThanOrEqual(max * 0.8)
      expect(r).toBeLessThanOrEqual(max * 1.1)
    }
    expect(mean(settled)).toBeGreaterThan(max * 0.85)
    expect(neu.changes).toBeLessThan(old.changes)
    expect(neu.changes).toBeLessThanOrEqual(25)
    // The old policy swings far below the sustainable rate.
    expect(Math.min(...oldSettled)).toBeLessThan(max * 0.7)
    expect(mean(settled)).toBeGreaterThan(mean(oldSettled))
  })

  it('accounts for other traffic on the uplink', () => {
    const other = 1500
    const max = sustainable(14_000 - other)
    const r = simulate(new CongestionController(), () => 14_000, 180, other)
    // The other traffic is learned from the first quiet samples; after that, settled as before.
    const settled = between(r.rates, 80, 180)
    console.log(`ceiling 14 Mbps wire, 1.5 Mbps other (max ${Math.round(max)} kbps video): ${Math.min(...settled)}..${Math.max(...settled)}, ${r.changes} changes`)
    for (const x of settled) {
      expect(x).toBeGreaterThanOrEqual(max * 0.8)
      expect(x).toBeLessThanOrEqual(max * 1.1)
    }
  })

  it('recovers to the chosen quality when the ceiling rises', () => {
    const r = simulate(new CongestionController(), (t) => (t < 120 ? 14_000 : 30_000), 300)
    const reachedAt = r.rates.find((x) => x.t > 120 && x.kbps === QUALITY)?.t
    console.log(`ceiling 14 → 30 Mbps at 120 s: back to 16 Mbps at ${reachedAt} s`)
    expect(reachedAt).toBeDefined()
    expect(reachedAt!).toBeLessThan(120 + 110)
    expect(between(r.rates, 240, 300).every((x) => x === QUALITY)).toBe(true)
  })

  it('still cuts hard on genuinely severe congestion', () => {
    const r = simulate(new CongestionController(), (t) => (t < 60 ? 30_000 : 3_000), 120)
    const max = sustainable(3_000)
    const at = (t: number) => r.rates.find((x) => x.t >= t)!.kbps
    expect(at(58)).toBe(QUALITY)
    // Within the first few seconds, at least halved (and halved again as needed).
    expect(at(64)).toBeLessThanOrEqual(QUALITY / 2)
    const settled = between(r.rates, 100, 120)
    console.log(`ceiling 30 → 3 Mbps at 60 s (max ${Math.round(max)} kbps): settled ${Math.min(...settled)}..${Math.max(...settled)}`)
    for (const x of settled) {
      expect(x).toBeLessThanOrEqual(max * 1.1)
      expect(x).toBeGreaterThanOrEqual(max * 0.6)
    }
  })

  it('halves blind when nothing gets through', () => {
    const cc = new CongestionController()
    const d = cc.sample({ now: 10_000, full: true, sentKbps: 0, currentKbps: 8000, maxKbps: QUALITY, dropsPerS: 200, queueMs: 2000, ownWireKbpsAt: ownWire })
    expect(d?.kbps).toBe(4000)
    expect(cc.hint).toBeNull()
  })

  it('lets a ceiling hint expire after a minute clean', () => {
    const cc = new CongestionController()
    const base = { maxKbps: QUALITY, dropsPerS: 0, queueMs: 0, ownWireKbpsAt: ownWire }
    cc.sample({ ...base, now: 0, full: true, sentKbps: ownWire(8000), currentKbps: 10_000, queueMs: 1000 })
    expect(cc.hint?.kbps).toBeCloseTo(8000, -1)
    // Clean from 2 s at 7.2 Mbps: back to 95% of the hint after 5 s, then +5% per 10 s.
    let v = 7200
    const ups: number[] = []
    for (let t = 2000; t <= 70_000; t += 2000) {
      const d = cc.sample({ ...base, now: t, full: false, sentKbps: ownWire(v), currentKbps: v })
      if (d) {
        v = applyRate(d.kbps, QUALITY)
        ups.push(t)
      }
    }
    expect(ups[0]).toBe(8000)
    expect(cc.hint).toBeNull()
    expect(v).toBeGreaterThan(8000 * 1.2)
  })
})
