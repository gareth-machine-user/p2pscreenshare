// Capacity: each peer measures its own upload, decides how to split it across the channels it
// publishes and watches, and advertises the result as relay slots. Publishers plan only within
// what was offered, so no two publishers can spend the same upload. Pure, for unit tests.
//
// A connection's capacity is the browser's own bandwidth estimate for its carrier track (getStats
// availableOutgoingBitrate, capped for the round trip: CapacityModel.setKnown), and the uplink's is
// the sum of those estimates. Where a browser publishes none (Firefox, Safari) a connection falls
// back to measuring: the rate it delivered (bytes handed to its carrier, less what its send buffer
// grew by) every 2 s, and whether it was backlogged meanwhile (its uplink queue never emptied: it
// carried all it could). Measured capacity is the most delivered while backlogged over the last
// 40 s (a max filter, as in BBR), held in between, and raised by whatever is delivered.
import type { LinkSnap } from '../net/uplink'
import { tuning } from '../tuning'

export type { LinkSnap }

/** Share of the measured upload that may be planned (keyframe bursts, estimate error). */
export const HEADROOM = 0.75
export const MAX_FANOUT = 16

export interface OwnChannel {
  id: number
  stripeKbps: number
  stripes: number
}

export interface WatchedChannel {
  id: number
  stripeKbps: number
  /** Budget weight (1 by default; shifted towards channels with a deficit). */
  weight: number
}

export interface BudgetSplit {
  budgetKbps: number
  /** Child slots for the root of each channel this peer publishes. */
  rootSlots: Record<number, number>
  /** Relay slots offered per watched channel (gossiped). */
  offers: Record<number, number>
}

/**
 * Splits `B = capacity × HEADROOM`: a publisher first reserves what its own channels' roots can
 * use (up to maxFanout children per stripe), and the rest is split across the channels it
 * watches in proportion to stripe bitrate × weight, rounded down to whole slots.
 */
export function splitBudget(capacityKbps: number | null, own: OwnChannel[], watched: WatchedChannel[], maxFanout = MAX_FANOUT): BudgetSplit {
  const budgetKbps = capacityKbps === null ? 0 : Math.max(0, capacityKbps * HEADROOM)
  const rootSlots: Record<number, number> = {}
  const offers: Record<number, number> = {}

  const ownNeed = own.map((c) => c.stripes * c.stripeKbps * maxFanout)
  const ownTotal = ownNeed.reduce((a, b) => a + b, 0)
  const ownBudget = Math.min(budgetKbps, ownTotal)
  own.forEach((c, i) => {
    const share = ownTotal > 0 ? (ownBudget * ownNeed[i]) / ownTotal : 0
    // The publisher must emit every stripe at least once, whatever its budget.
    rootSlots[c.id] = Math.max(c.stripes, Math.floor(share / c.stripeKbps))
  })

  const rest = budgetKbps - ownBudget
  const totalWeight = watched.reduce((a, c) => a + c.stripeKbps * c.weight, 0)
  for (const c of watched) {
    if (!(c.stripeKbps > 0)) {
      offers[c.id] = 0 // a non-finite offer would serialize as null and invalidate this peer's record
      continue
    }
    const share = totalWeight > 0 ? (rest * c.stripeKbps * c.weight) / totalWeight : 0
    offers[c.id] = Math.max(0, Math.min(maxFanout, Math.floor(share / c.stripeKbps)))
  }
  return { budgetKbps, rootSlots, offers }
}

/** Opus bitrate: transparent stereo for music and game audio, with headroom for sources that were
 *  already lossy (e.g. YouTube); 64 kbps sounded compressed. Erasure coded, so cheap per stripe. */
export const AUDIO_KBPS = 192
/** Opus frame length. 40 ms rather than 20: half as many pieces, so half the per-piece header
 *  and signature overhead, for 20 ms more delay (small next to the playout delay). */
export const AUDIO_FRAME_MS = 40

/** Kbps of one stripe: 1/k of the video and of the audio, plus framing and signatures. */
export function stripeKbpsFor(bitrateKbps: number, k: number, audio: boolean): number {
  // ~30 video fragments per second. Audio is erasure coded like the video: each stripe carries
  // 1/k of every audio frame, with a 40-byte header and a 64-byte signature.
  const audioKbps = AUDIO_KBPS / k + ((1000 / AUDIO_FRAME_MS) * (40 + 64) * 8) / 1000
  return (bitrateKbps / k) * 1.05 + 15 + (audio ? audioKbps : 0)
}

/**
 * Deficit-driven budget weights: every round a peer moves `step` of the weight of each channel
 * without a deficit to the channels that have one (split evenly). With a single publisher this
 * does nothing; with several, starved channels gain relay slots within a few rounds, without
 * any negotiation. Weights are kept above a floor so no channel is starved in turn.
 */
export function rebalanceWeights(
  weights: Record<string, number>,
  deficits: Record<string, number>,
  step = 0.1,
  floor = 0.2,
): Record<string, number> {
  const ids = Object.keys(weights)
  const short = ids.filter((id) => (deficits[id] ?? 0) > 0)
  const fine = ids.filter((id) => (deficits[id] ?? 0) <= 0)
  if (!short.length || !fine.length) return { ...weights }
  const out = { ...weights }
  let pool = 0
  for (const id of fine) {
    const give = Math.min(out[id] * step, Math.max(0, out[id] - floor))
    out[id] -= give
    pool += give
  }
  for (const id of short) out[id] += pool / short.length
  return out
}

/**
 * Can the audience carry a channel? Each of N subscribers needs one parent per stripe, so a
 * channel needs N × S child slots; supply is the publisher's root slots plus what subscribers
 * offer. Returns supply / demand (≥ 1: feasible).
 */
export function feasibilityRatio(subscribers: number, stripes: number, supplySlots: number): number {
  const demand = subscribers * stripes
  return demand === 0 ? Infinity : supplySlots / demand
}

/**
 * A bitrate the audience can carry: slots scale with 1 / stripe bitrate, so scaling the bitrate
 * by the supply ratio (with 10% margin) makes supply meet demand. Never below `floorKbps`.
 */
export function feasibleBitrate(currentKbps: number, ratio: number, floorKbps = 300): number {
  if (!Number.isFinite(ratio) || ratio >= 1) return currentKbps
  return Math.max(floorKbps, Math.round((currentKbps * ratio * 0.9) / 50) * 50)
}

/**
 * Capacity is the most delivered over this long (ms), counting backlogged windows: longer than the
 * headroom probes' 30 s cadence, so one backlogged window between probes doesn't forget the last
 * probe and set capacity to what the stream happened to carry.
 */
export const CAPACITY_WINDOW_MS = 40_000
/**
 * FAST_DROP_WINDOWS backlogged windows in a row queueing longer than this (ms) set the capacity at
 * once (no max filter): half what the base layer may queue before it is dropped (1250 ms for
 * quality, 450 ms for latency).
 */
export const FAST_DROP_QUEUE_MS = tuning.maxAgeByLayer[0] / 2
/**
 * ...about 6 s of it. A single deep window is mostly a burst (a keyframe at a new bitrate, a
 * joiner's catch-up, a short stall), and what it delivered is the burst being recovered, not the
 * link's rate.
 */
export const FAST_DROP_WINDOWS = 3
/** A link is backlogged when its uplink queue held something for this share of a window... */
export const BACKLOGGED_SHARE = 0.9
/**
 * ...and what waited there shows it: live media queued this long on average (ms), or frames were
 * dropped. A queue that is merely never empty (a busy, fast link fed fragment by fragment) is not a
 * full uplink, and taking what it delivered as capacity cut the bitrate, which cut what was
 * delivered, down to the floor.
 */
export const CONGESTED_QUEUE_MS = 150
/**
 * Without an estimate, a connection's backlog says what it can carry only once it has been open
 * this long (ms): before that it is backlogged by its catch-up (the GOP replay) and its own start,
 * not by the uplink or the receiver. It holds a new viewer's pushback off just as long
 * (session/presenterRate.ts).
 */
export const SETTLE_MS = 30_000
/**
 * The browser's estimate counts once it has been polled this long (ms), every 2 s, so from the
 * third poll on: the first can still be the seeded start (mesh/carrierLink.ts CARRIER_START_KBPS),
 * and Chromium's initial probes (3 and 6 times that, as the carrier starts) take a second or two
 * to show in it.
 */
export const ESTIMATE_SETTLE_MS = 3000
/** The page froze in a window when the main thread lagged this long (ms): the window is ignored. */
export const FROZEN_LAG_MS = 400

/**
 * What a channel delivered over `ms`: the bytes handed to it, less what its send buffer grew by
 * (bytes still waiting there weren't delivered yet; a buffer that shrank delivered more), in kbps.
 */
export function deliveredKbps(handedBytes: number, bufferedBefore: number, bufferedAfter: number, ms: number): number {
  if (!(ms > 0)) return 0
  return (Math.max(0, handedBytes - (bufferedAfter - bufferedBefore)) * 8) / ms
}

/** One connection over one window. */
export interface ConnWindow {
  /** Which connection. */
  id: unknown
  peer: string
  /** Delivered rate (kbps), all channels of the connection. */
  kbps: number
  /** It carried live media (or had some waiting). */
  active: boolean
  /** Its uplink queue held something for essentially the whole window, and media queued or dropped. */
  backlogged: boolean
  /** It stalled in the window (its send buffer stopped draining). */
  stalled: boolean
  /**
   * Its backlog says nothing of capacity, so it sets none: the connection is settling (open less
   * than SETTLE_MS), it carried a child's catch-up (a GOP replay), or the stream just changed quality.
   */
  transient?: boolean
  /** Live media queueing: the average of what was sent, or the oldest item still waiting (ms). */
  queueMs: number
}

/** A window between two snapshots, plus the live-media figures the UI shows. */
export function linkWindow(id: unknown, peer: string, a: LinkSnap, b: LinkSnap): ConnWindow & { mediaKbps: number; dropsPerS: number } {
  const ms = b.at - a.at
  const items = b.items - a.items
  const drops = b.drops - a.drops
  const busy = b.busyMs - a.busyMs
  const qN = b.qN - a.qN
  const queueMs = Math.max(qN > 0 ? (b.qSum - a.qSum) / qN : 0, b.headAgeMs)
  return {
    id,
    peer,
    kbps: deliveredKbps(b.handed - a.handed, a.buffered, b.buffered, ms),
    active: items > 0 || drops > 0 || busy > 0,
    backlogged: ms > 0 && busy >= BACKLOGGED_SHARE * ms && (queueMs >= CONGESTED_QUEUE_MS || drops > 0),
    stalled: b.lastStallAt > a.at,
    transient: b.replayed > a.replayed,
    queueMs,
    mediaKbps: ms > 0 ? ((b.mediaBytes - a.mediaBytes) * 8) / ms : 0,
    dropsPerS: ms > 0 ? (drops * 1000) / ms : 0,
  }
}

/**
 * One measured capacity (kbps), for a connection without the browser's estimate: the most
 * delivered over the last CAPACITY_WINDOW_MS, set by windows in which the link (or uplink) carried
 * all it could. Between them it holds; any window raises it to at least what was delivered.
 * FAST_DROP_WINDOWS samples in a row queueing past FAST_DROP_QUEUE_MS replace it at once with the
 * most any of them delivered: the link carries less than it used to.
 */
export class MaxFilter {
  /** The most delivered (kbps), null until measured. */
  kbps: number | null = null
  /** When the last fast drop set it, or -Infinity. */
  droppedAt = -Infinity
  private recent: { at: number; kbps: number }[] = []
  /** What the deep-queued samples in a row so far delivered. */
  private deep: number[] = []

  /** A window that carried all it could. */
  sample(now: number, kbps: number, queueMs = 0): void {
    this.deep = queueMs > FAST_DROP_QUEUE_MS ? [...this.deep, kbps] : []
    if (this.deep.length >= FAST_DROP_WINDOWS) {
      this.recent = [{ at: now, kbps: Math.max(...this.deep) }]
      this.deep = []
      this.droppedAt = now
    } else {
      this.recent = this.recent.filter((s) => now - s.at < CAPACITY_WINDOW_MS)
      this.recent.push({ at: now, kbps })
    }
    this.kbps = Math.max(...this.recent.map((s) => s.kbps))
  }

  /**
   * A window that carried less than it could: capacity is at least this (`init`: even if unknown).
   * While unknown it is still remembered, so the first measurement can't fall below what was just
   * delivered: on a long path a connection's first backlogged window often comes right after a
   * loss, at a fraction of what it carried before (its congestion window halved).
   */
  raise(now: number, kbps: number, init = false): void {
    // The queue drained (or was only shared): the deep run is over.
    this.deep = []
    this.recent = this.recent.filter((s) => now - s.at < CAPACITY_WINDOW_MS)
    this.recent.push({ at: now, kbps })
    if (this.kbps === null && !init) return
    if (this.kbps === null || kbps > this.kbps) this.kbps = kbps
  }
}

/**
 * Per-connection, per-peer and uplink capacity: the browser's estimates where it publishes them
 * (setKnown), delivered-rate windows elsewhere.
 *
 * - A connection with an estimate (its carrier's GCC estimate, capped) reports it, and is `bound`:
 *   it is that path's limit, decided by the browser, which probes and backs off on its own. It
 *   counts for its peer and for the uplink once polled for ESTIMATE_SETTLE_MS (`settled`). Its
 *   windows measure nothing: what it delivers is what its token bucket let through, at most the
 *   estimate, so measuring it would only read the estimate back, and each connection backlogged by
 *   its own bucket looked like a full shared uplink.
 * - The uplink's capacity is then the sum of the settled estimates (null until one is). Each
 *   estimate is what that connection carries now; where they share a bottleneck each one's GCC
 *   backs off to its share, a headroom probe loading them all at once included. Without any
 *   estimate it is measured: windows in which most active connections were backlogged at once (the
 *   shared uplink carried all it could), the total delivered. Headroom probes are such windows.
 * - Without an estimate, a connection's capacity is set by windows in which it was backlogged
 *   while most were not: it alone carried all it could (a slow receiver). Such a connection is
 *   `bound`. When most are backlogged together, each one's share says only how the uplink was
 *   split, so it merely raises the connection's capacity.
 * - A peer's capacity is the sum over its connections.
 *
 * A `transient` window (a connection without an estimate open less than SETTLE_MS, a catch-up
 * replay, a quality change) counts as not backlogged, in probes too: it only raises capacities
 * already measured, and gives none a first value. Windows in which the page froze are ignored, and
 * so are stalled connections (any stall in a window keeps it from setting the uplink's capacity,
 * though while it is unknown such a window, or probe, gives it a first, low value).
 */
export class CapacityModel {
  /** The measured uplink, from connections without an estimate. */
  readonly uplink = new MaxFilter()
  /** When a headroom probe last ran over open connections (not only transient ones), or -Infinity. */
  probedAt = -Infinity
  private conns = new Map<unknown, { peer: string; filter: MaxFilter; bound: boolean }>()
  /** Connections whose capacity the browser estimates (kbps), by id, and when it was first polled. */
  private known = new Map<unknown, { peer: string; kbps: number; since: number; settled: boolean }>()

  /**
   * The uplink's own shaper (the up= debug cap, kbps; net/uplink.ts), if any. It sits before the
   * carriers, where no estimate sees it, so it bounds the estimates' sum directly. (Measured
   * capacity sees it, as it sees any bottleneck.)
   */
  capKbps: number | null = null

  /**
   * The uplink's capacity (kbps), null until known: what a peer gossips as capacityKbps. The sum of
   * the settled estimates (at most capKbps), or, on a browser that publishes none, measured.
   */
  get uplinkKbps(): number | null {
    if (!this.known.size) return this.uplink.kbps
    let sum: number | null = null
    for (const k of this.known.values()) if (k.settled) sum = (sum ?? 0) + k.kbps
    return sum === null ? null : Math.min(sum, this.capKbps ?? Infinity)
  }

  /** The uplink's capacity is the browser's estimates, not a measurement. */
  get estimated(): boolean {
    return this.known.size > 0
  }

  /** When a measured capacity last fell at once (a fast drop), or -Infinity. */
  get fastDropAt(): number {
    let at = this.uplink.droppedAt
    for (const c of this.conns.values()) at = Math.max(at, c.filter.droppedAt)
    return at
  }

  /** One window over every connection. `probe`: a headroom probe kept them all backlogged. */
  update(now: number, all: ConnWindow[], o: { frozen?: boolean; probe?: boolean } = {}): void {
    if (o.frozen || !all.length) return
    if (o.probe && all.some((w) => !w.stalled && (this.known.has(w.id) || !w.transient))) this.probedAt = now
    // Connections with an estimate measure nothing (see above).
    const windows = all.filter((w) => !this.known.has(w.id))
    if (!windows.length) return
    const ok = windows.filter((w) => !w.stalled)
    const full = (w: ConnWindow) => w.backlogged && !w.transient
    const active = ok.filter((w) => w.active)
    const backlogged = active.filter(full)
    const shared = backlogged.length * 2 > active.length
    for (const w of ok) {
      const c = this.connFor(w)
      if (w.active && full(w) && !shared) {
        c.filter.sample(now, w.kbps, w.queueMs)
        c.bound = true
      } else c.filter.raise(now, w.kbps, !!o.probe && !w.transient)
    }
    const total = windows.reduce((a, w) => a + w.kbps, 0)
    // With nothing measured yet, a window that stalled while everything was backlogged (or a probe)
    // still shows the uplink carries at least what it delivered. Without it, an uplink overloaded
    // from the start, which stalls in every window, was never measured, and the stream kept
    // sending at the chosen quality into it.
    const allActive = windows.filter((w) => w.active)
    const overloaded = allActive.length > 0 && allActive.every(full)
    if (shared && ok.length === windows.length) {
      const queueMs = backlogged.reduce((a, w) => a + w.queueMs, 0) / backlogged.length
      this.uplink.sample(now, total, queueMs)
    } else this.uplink.raise(now, total, (!!o.probe && ok.some((w) => !w.transient)) || overloaded)
  }

  private connFor(w: ConnWindow): { peer: string; filter: MaxFilter; bound: boolean } {
    let c = this.conns.get(w.id)
    if (!c) this.conns.set(w.id, (c = { peer: w.peer, filter: new MaxFilter(), bound: false }))
    return c
  }

  /**
   * The browser's bandwidth estimate for connection `id` to `peer` (kbps), polled from getStats at
   * `now`; null (or no usable number) clears it. While set, it is the connection's capacity (see
   * above), counting from ESTIMATE_SETTLE_MS after its first poll.
   */
  setKnown(id: unknown, peer: string, kbps: number | null, now: number): void {
    if (kbps === null || !Number.isFinite(kbps) || kbps < 0) {
      this.known.delete(id)
      return
    }
    // What its windows measured before is forgotten: if the estimate goes away, it measures afresh.
    if (!this.known.has(id)) this.conns.delete(id)
    const since = this.known.get(id)?.since ?? now
    this.known.set(id, { peer, kbps, since, settled: now - since >= ESTIMATE_SETTLE_MS })
  }

  /**
   * A peer's capacity: the sum over its connections (settled estimates and measured ones alike);
   * `bound` if one of them was its own bottleneck, or has the browser's estimate; `estimated` if
   * one has the browser's estimate.
   */
  peer(peer: string): { kbps: number | null; bound: boolean; estimated: boolean } {
    let kbps: number | null = null
    let bound = false
    for (const k of this.known.values()) {
      if (k.peer !== peer || !k.settled) continue
      kbps = (kbps ?? 0) + k.kbps
      bound = true
    }
    const estimated = bound
    for (const [id, c] of this.conns) {
      if (c.peer !== peer || this.known.has(id)) continue
      if (c.filter.kbps !== null) kbps = (kbps ?? 0) + c.filter.kbps
      bound ||= c.bound
    }
    return { kbps, bound, estimated }
  }

  /**
   * One connection's capacity, and whether it was its own bottleneck (always, with an estimate,
   * settled or not: this is what the Peers panel shows).
   */
  conn(id: unknown): { kbps: number | null; bound: boolean; estimated: boolean } | null {
    const k = this.known.get(id)
    if (k) return { kbps: k.kbps, bound: true, estimated: true }
    const c = this.conns.get(id)
    return c ? { kbps: c.filter.kbps, bound: c.bound, estimated: false } : null
  }

  /** Drops connections not in `keep` (closed), with their estimates. */
  retain(keep: Set<unknown>): void {
    for (const id of this.conns.keys()) if (!keep.has(id)) this.conns.delete(id)
    for (const id of this.known.keys()) if (!keep.has(id)) this.known.delete(id)
  }
}
