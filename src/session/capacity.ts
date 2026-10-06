// Capacity: each peer measures its own upload, decides how to split it across the channels it
// publishes and watches, and advertises the result as relay slots. Publishers plan only within
// what was offered, so no two publishers can spend the same upload. Pure, for unit tests.
//
// What is measured is one quantity: the rate each connection delivered (bytes handed to its
// channels, less what its send buffers grew by), every 2 s, and whether it was backlogged meanwhile
// (its uplink queue never emptied: it carried all it could). Capacity is the most a connection, or
// the whole uplink, delivered while backlogged over the last 10 s (a max filter, as in BBR), held
// in between, and raised by whatever is delivered. See CapacityModel.

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

/** Capacity is the most delivered over this long (ms), counting backlogged windows. */
export const CAPACITY_WINDOW_MS = 10_000
/** A backlogged window queueing longer than this (ms) sets the capacity at once (no max filter). */
export const FAST_DROP_QUEUE_MS = 1000
/** A link is backlogged when its uplink queue held something for this share of a window. */
export const BACKLOGGED_SHARE = 0.9
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

/** One connection's cumulative counters at an instant (its media and bin channels together). */
export interface LinkSnap {
  at: number
  /** Bytes handed to the connection's channels (net/uplink.ts LinkCounters.handedBytes). */
  handed: number
  /** Their bufferedAmount. */
  buffered: number
  /** How long the media link's uplink queue has held something (Uplink.busyMs). */
  busyMs: number
  /** Live media items and bytes sent, drops, queueing sum and count. */
  items: number
  mediaBytes: number
  drops: number
  qSum: number
  qN: number
  /** When the connection was last seen stalled (net/uplink.ts STALL_MS), or -Infinity. */
  lastStallAt: number
  /** How long the oldest item waiting for it has waited (ms). */
  headAgeMs: number
}

/** One connection over one window. */
export interface ConnWindow {
  /** Which connection (a mesh link or a lane). */
  id: unknown
  peer: string
  /** Delivered rate (kbps), all channels of the connection. */
  kbps: number
  /** It carried live media (or had some waiting). */
  active: boolean
  /** Its uplink queue held something for essentially the whole window. */
  backlogged: boolean
  /** It stalled in the window (its send buffer stopped draining). */
  stalled: boolean
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
  return {
    id,
    peer,
    kbps: deliveredKbps(b.handed - a.handed, a.buffered, b.buffered, ms),
    active: items > 0 || drops > 0 || busy > 0,
    backlogged: ms > 0 && busy >= BACKLOGGED_SHARE * ms,
    stalled: b.lastStallAt > a.at,
    queueMs: Math.max(qN > 0 ? (b.qSum - a.qSum) / qN : 0, b.headAgeMs),
    mediaKbps: ms > 0 ? ((b.mediaBytes - a.mediaBytes) * 8) / ms : 0,
    dropsPerS: ms > 0 ? (drops * 1000) / ms : 0,
  }
}

/**
 * One capacity estimate (kbps): the most delivered over the last CAPACITY_WINDOW_MS, set by
 * windows in which the link (or uplink) carried all it could. Between them it holds; any window
 * raises it to at least what was delivered. A sample queueing past FAST_DROP_QUEUE_MS replaces it
 * at once: the link is clearly carrying less than it used to.
 */
export class MaxFilter {
  kbps: number | null = null
  private recent: { at: number; kbps: number }[] = []

  /** A window that carried all it could. */
  sample(now: number, kbps: number, queueMs = 0): void {
    this.recent = queueMs > FAST_DROP_QUEUE_MS ? [] : this.recent.filter((s) => now - s.at < CAPACITY_WINDOW_MS)
    this.recent.push({ at: now, kbps })
    this.kbps = Math.max(...this.recent.map((s) => s.kbps))
  }

  /** A window that carried less than it could: capacity is at least this (`init`: even if unknown). */
  raise(now: number, kbps: number, init = false): void {
    if (this.kbps === null && !init) return
    this.recent = this.recent.filter((s) => now - s.at < CAPACITY_WINDOW_MS)
    this.recent.push({ at: now, kbps })
    if (this.kbps === null || kbps > this.kbps) this.kbps = kbps
  }
}

/**
 * Per-connection, per-peer and uplink capacity from delivered-rate windows.
 *
 * - The uplink's capacity is set by windows in which most active connections were backlogged at
 *   once (the shared uplink carried all it could): the total delivered. Headroom probes are such
 *   windows. Until one comes, it is unknown.
 * - A connection's capacity is set by windows in which it was backlogged while most were not: it
 *   alone carried all it could (a slow receiver, or one connection's congestion window). Such a
 *   connection is `bound`. When most connections are backlogged together, each one's share says
 *   only how the uplink was split, so it merely raises the connection's estimate.
 * - A peer's capacity is the sum over its connections.
 *
 * Windows in which the page froze are ignored, and so are stalled connections (a stall says nothing
 * about the link's rate; any stall in a window keeps it from setting the uplink's capacity).
 */
export class CapacityModel {
  readonly uplink = new MaxFilter()
  private conns = new Map<unknown, { peer: string; filter: MaxFilter; bound: boolean }>()

  /** The uplink's capacity (kbps), null until measured: what a peer gossips as capacityKbps. */
  get uplinkKbps(): number | null {
    return this.uplink.kbps
  }

  /** One window over every connection. `probe`: a headroom probe kept them all backlogged. */
  update(now: number, windows: ConnWindow[], o: { frozen?: boolean; probe?: boolean } = {}): void {
    if (o.frozen || !windows.length) return
    const ok = windows.filter((w) => !w.stalled)
    const active = ok.filter((w) => w.active)
    const backlogged = active.filter((w) => w.backlogged)
    const shared = backlogged.length * 2 > active.length
    for (const w of ok) {
      let c = this.conns.get(w.id)
      if (!c) this.conns.set(w.id, (c = { peer: w.peer, filter: new MaxFilter(), bound: false }))
      if (w.active && w.backlogged && !shared) {
        c.filter.sample(now, w.kbps, w.queueMs)
        c.bound = true
      } else c.filter.raise(now, w.kbps, !!o.probe)
    }
    const total = windows.reduce((a, w) => a + w.kbps, 0)
    if (shared && ok.length === windows.length) {
      const queueMs = backlogged.reduce((a, w) => a + w.queueMs, 0) / backlogged.length
      this.uplink.sample(now, total, queueMs)
    } else this.uplink.raise(now, total)
  }

  /** A peer's capacity: the sum over its connections; `bound` if one of them was its own bottleneck. */
  peer(peer: string): { kbps: number | null; bound: boolean } {
    let kbps: number | null = null
    let bound = false
    for (const c of this.conns.values()) {
      if (c.peer !== peer) continue
      if (c.filter.kbps !== null) kbps = (kbps ?? 0) + c.filter.kbps
      bound ||= c.bound
    }
    return { kbps, bound }
  }

  /** One connection's capacity, and whether it was its own bottleneck. */
  conn(id: unknown): { kbps: number | null; bound: boolean } | null {
    const c = this.conns.get(id)
    return c ? { kbps: c.filter.kbps, bound: c.bound } : null
  }

  /** Drops connections not in `keep` (closed). */
  retain(keep: Set<unknown>): void {
    for (const id of this.conns.keys()) if (!keep.has(id)) this.conns.delete(id)
  }
}
