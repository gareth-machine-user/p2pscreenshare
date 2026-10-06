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

/**
 * Upload estimate: the probe result, capped while the uplink drops packets. Drops above 3% cap
 * the estimate at 90% of the achieved rate; with no drops the cap relaxes by 5% per sample (2 s)
 * back towards the probe value.
 */
export class CapacityEstimator {
  probeKbps: number | null = null
  observedCapKbps: number | null = null

  setProbe(kbps: number): void {
    this.probeKbps = kbps
    if (this.observedCapKbps !== null && this.observedCapKbps > kbps) this.observedCapKbps = null
  }

  /** One uplink sample (every ~2 s): achieved kbps and the share of items dropped. */
  observe(uplinkKbps: number, dropRate: number): void {
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

/** Kbps of one stripe: 1/k of the video plus framing, signatures and (duplicated) audio. */
export function stripeKbpsFor(bitrateKbps: number, k: number, audio: boolean): number {
  // ~30 video and ~50 audio fragments per second, each with a 64-byte signature.
  return (bitrateKbps / k) * 1.05 + 15 + (audio ? 70 + 26 : 0)
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
