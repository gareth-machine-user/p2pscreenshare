// Capacity: each peer measures its own upload, decides how to split it across the channels it
// publishes and watches, and advertises the result as relay slots. Publishers plan only within
// what was offered, so no two publishers can spend the same upload. Pure, for unit tests.

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

/** A probe below this share of the current probe estimate is a large drop, which needs confirming. */
export const PROBE_DROP_SHARE = 0.5
/** A large drop is confirmed by a second one (or by uplink drops) within this window. */
export const PROBE_DROP_CONFIRM_MS = 10 * 60_000

/**
 * Upload estimate: the probe result, capped while the uplink drops packets. Drops above 3% cap
 * the estimate at 90% of the achieved rate; with no drops the cap relaxes by 5% per sample (2 s)
 * back towards the probe value.
 *
 * Probes may raise the estimate freely, but one probe can't cut it below half: a single bad probe
 * (a throttled background tab, a busy main thread) would otherwise shrink every relay offer. A
 * large drop is applied once a second probe agrees, or once the uplink itself shows drops.
 */
export class CapacityEstimator {
  probeKbps: number | null = null
  observedCapKbps: number | null = null
  /** A large drop seen once, waiting for confirmation. */
  pendingDrop: { kbps: number; at: number } | null = null

  /** A probe result. Returns whether the estimate changed (false while a large drop is unconfirmed). */
  setProbe(kbps: number, now = performance.now()): boolean {
    if (this.probeKbps !== null && kbps < this.probeKbps * PROBE_DROP_SHARE) {
      const pending = this.pendingDrop
      if (!pending || now - pending.at > PROBE_DROP_CONFIRM_MS) {
        this.pendingDrop = { kbps, at: now }
        return false
      }
      // Confirmed: of the two low results, trust the higher one.
      kbps = Math.max(kbps, pending.kbps)
    }
    this.applyProbe(kbps)
    return true
  }

  private applyProbe(kbps: number): void {
    this.pendingDrop = null
    this.probeKbps = kbps
    if (this.observedCapKbps !== null && this.observedCapKbps > kbps) this.observedCapKbps = null
  }

  /** One uplink sample (every ~2 s): achieved kbps and the share of items dropped. */
  observe(uplinkKbps: number, dropRate: number, now = performance.now()): void {
    // The uplink is dropping: a large drop a probe saw recently was real after all.
    if (dropRate > 0.03 && this.pendingDrop && now - this.pendingDrop.at <= PROBE_DROP_CONFIRM_MS) this.applyProbe(this.pendingDrop.kbps)
    if (dropRate > 0.03 && uplinkKbps > 0) {
      const cap = uplinkKbps * 0.9
      this.observedCapKbps = this.observedCapKbps === null ? cap : Math.min(this.observedCapKbps, cap)
    } else if (this.observedCapKbps !== null) {
      this.observedCapKbps *= 1.05
      if (this.probeKbps !== null && this.observedCapKbps > this.probeKbps) this.observedCapKbps = null
    }
  }

  get estimateKbps(): number | null {
    if (this.probeKbps === null) return this.observedCapKbps
    return this.observedCapKbps === null ? this.probeKbps : Math.min(this.probeKbps, this.observedCapKbps)
  }
}

/** Opus bitrate: near-transparent stereo for music and game audio (64 kbps sounded compressed). */
export const AUDIO_KBPS = 128
/** Opus frame length. 40 ms rather than 20: half as many pieces, so half the per-piece header
 *  and signature overhead, for 20 ms more delay (small next to the playout delay). */
export const AUDIO_FRAME_MS = 40

/** Kbps of one stripe: 1/k of the video plus framing, signatures and (duplicated) audio. */
export function stripeKbpsFor(bitrateKbps: number, k: number, audio: boolean): number {
  // ~30 video fragments per second. Every stripe carries every audio frame whole, each with a
  // 40-byte header and a 64-byte signature.
  const audioKbps = AUDIO_KBPS + ((1000 / AUDIO_FRAME_MS) * (40 + 64) * 8) / 1000
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

/** Per peer this uplink sends media to: its link congestion and what its path shows. */
export interface PeerLinkState {
  /** Most of the peer's connections backed up (queueing or drops past the thresholds). */
  congested: boolean
  /** Live fragments dropped per second on the way to this peer. */
  drops: number
  /**
   * Queueing in the network on the path to this peer: its RTT (the connections' ICE candidate
   * pairs) inflated above the baseline. Null when unknown (no fresh RTT history).
   */
  pathQueued: boolean | null
}

export interface UplinkFull {
  /** Peers that counted towards "full". */
  congested: number
  active: number
  /** What showed it: inflated path RTTs, heavy drops, or (RTT unknown) congestion alone. */
  signal: 'rtt' | 'loss' | 'fallback'
}

/** Drops per second to a peer that count as heavy loss whatever its RTT does. */
export const HEAVY_DROPS_PER_S = 10

/**
 * Is a peer's uplink itself full? A full uplink congests most of its links at once, while one slow
 * receiver (its downlink or path) congests only its own: more than `share` of the active peers
 * must count.
 *
 * A congested peer counts only if its path shows queueing in the network (RTT inflated above its
 * baseline). Congested with a flat RTT is the connections' own ceiling (each SCTP association's
 * congestion window, or a slow receiver): media lanes absorb that, and a lower bitrate wouldn't
 * help the uplink. Routers with fq_codel/SQM keep queues short, so a full link there shows drops
 * rather than RTT growth: heavy drops to most peers count whatever the RTT (on peers that are
 * congested, i.e. on most of their connections, not one stalled lane). A congested peer
 * without an RTT signal (stale or too little history) counts, as the plain majority rule.
 *
 * With a single peer, a bottleneck anywhere on the path (this uplink or that peer's downlink)
 * counts: nobody else is being sent to, so cutting is right either way.
 */
export function uplinkIsFull(peers: PeerLinkState[], share = 0.5, heavyDropsPerS = HEAVY_DROPS_PER_S): UplinkFull | null {
  const active = peers.length
  if (!active) return null
  // More than half: with two peers, one slow receiver is not a full uplink.
  const counted = peers.filter((p) => p.congested && p.pathQueued !== false)
  if (counted.length / active > share) {
    return { congested: counted.length, active, signal: counted.some((p) => p.pathQueued === null) ? 'fallback' : 'rtt' }
  }
  // Heavy drops count only on a peer most of whose connections are congested (peerLinkRates): one
  // stalled or backed-up lane of several drops a lot without the uplink being full.
  const lossy = peers.filter((p) => p.congested && p.drops >= heavyDropsPerS).length
  if (lossy / active > share) return { congested: lossy, active, signal: 'loss' }
  return null
}
