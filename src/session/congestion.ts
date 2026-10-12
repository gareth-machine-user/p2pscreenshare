// A presenter's video bitrate, from measured capacity (session/capacity.ts CapacityModel). Pure, so
// it can be simulated in tests; PeerSession calls it once per 2 s window.
//
// The stream needs one full copy (every stripe, parity included) per direct child, so the wire
// budget per child is the smaller of
//   - the uplink's capacity shared by the direct children, and
//   - the median capacity of the peers it feeds directly (scaled to a full copy for a peer fed
//     only some stripes), so one slow viewer can't hold everyone else down: it sheds enhancement
//     layers on its own link, and Auto quality can show it the preview. With the browser's
//     estimates, once most direct children are known, the median alone (see rateTarget);
// and the target is 85% of the video bitrate that budget carries (stripeKbpsFor's overhead), never
// above the chosen quality or what the audience's relay slots can carry.
//
// Capacities are normally the browser's estimates (session/capacity.ts), counted once polled for a
// few seconds. A child without one (a browser that publishes none) counts towards the median only
// once it has been fed for SETTLE_MS: its first measured windows (GOP replay, its connections still
// starting) say little about what it can take (session/presenterRate.ts).
//
// Pacing: changes under 5% are noise. A target set by the browser's estimates is authoritative:
// the bitrate goes straight to it, down or up, at most one cut and one raise per 4 s (and no raise
// within 4 s of a cut). A measured one is followed carefully: down at once (at most every 4 s) but
// by at most half unless capacity just fell at once (a fast drop: ~6 s of evidence), up by at most
// 25% per 10 s. Straight up to the target, though, once a probe confirms it (JumpGate): after the
// chosen quality went up, and after a cut that capacity no longer bears out.
// With viewers but nothing known yet (a first connection's estimate still settling, or the uplink
// unmeasured), it starts at no more than START_KBPS, and goes straight to the target once known.
import { SETTLE_MS } from './capacity'

/** Settle at this share of what the wire budget carries. */
export const TARGET_SHARE = 0.85
/** At most one cut per this long (ms); with the browser's estimates, one raise too, and none this soon after a cut. */
export const DOWN_GAP_MS = 4000
/** Measured capacity: at most one raise per this long (ms), and none this soon after a cut. */
export const UP_GAP_MS = 10_000
/** Measured capacity: a raise is at most this factor. */
export const UP_STEP = 1.25
/** Changes smaller than this share are ignored. */
export const DEADBAND = 0.05
/** Measured capacity: a cut is at most to this share of the bitrate, unless it just fell at once or is unmeasured. */
export const MAX_CUT = 0.5
/** A probe this recent (ms) confirms a raised quality: the bitrate goes straight to it. */
export const PROBE_FRESH_MS = 30_000
/**
 * Most a stream sends to its first viewers before anything is known of the uplink or them (kbps).
 * Sending the chosen quality, plus the new child's GOP replay, into an unmeasured 8 Mbit uplink
 * overflowed its queue and stalled the connection (control channel included) for seconds.
 */
export const START_KBPS = 4000

/** When each direct child started being fed, to hold off a measured pushback until SETTLE_MS. */
export class ViewerSettle {
  private since = new Map<string, number>()

  /** The current direct children; one no longer fed starts over if it comes back. */
  update(now: number, children: Iterable<string>): void {
    const keep = new Set(children)
    for (const p of this.since.keys()) if (!keep.has(p)) this.since.delete(p)
    for (const p of keep) if (!this.since.has(p)) this.since.set(p, now)
  }

  /** `peer` has been fed long enough for its capacity to count. */
  settled(now: number, peer: string): boolean {
    const t = this.since.get(peer)
    return t !== undefined && now - t >= SETTLE_MS
  }
}

/** The video bitrate at which `wire(video)` reaches `wireKbps` (wire is increasing in video). */
export function videoKbpsForWire(wireKbps: number, wire: (videoKbps: number) => number): number {
  if (!(wireKbps > wire(0))) return 0
  let lo = 0
  let hi = 1000
  while (wire(hi) < wireKbps && hi < 1e7) hi *= 2
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (wire(mid) < wireKbps) lo = mid
    else hi = mid
  }
  return lo
}

/** The upper median (of two, the larger: one slow viewer of two doesn't decide). */
export function upperMedian(xs: number[]): number {
  if (!xs.length) return Infinity
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export interface RateInputs {
  /** The quality the presenter chose (kbps): never above it. */
  chosenKbps: number
  /** What the audience's relay slots can carry (ChannelPublisher.limited), if that limits. */
  audienceKbps: number | null
  /** The uplink's capacity (kbps), null until known. */
  uplinkKbps: number | null
  /** The capacities are the browser's estimates (CapacityModel.estimated), not measured: the median of the children's decides, and is followed at once. */
  estimated?: boolean
  /** The uplink's own shaper, if any (the up= debug cap, kbps): estimates don't see it. */
  uplinkCapKbps?: number | null
  /** (child, stripe) edges from the publisher / stripes. */
  directChildren: number
  /**
   * Per peer fed directly: the full-copy wire rate its connections carry (kbps), or null when that
   * isn't known yet, or none of them has been its own bottleneck (it can take more than it is sent).
   */
  peerKbps: (number | null)[]
  /** Wire kbps of one full copy (every stripe) at a video bitrate. */
  wireAt: (videoKbps: number) => number
}

export type RateLimit = 'chosen' | 'uplink' | 'viewers' | 'audience' | 'unmeasured'

export interface RateTarget {
  kbps: number
  /** What sets it. */
  limit: RateLimit
  /** The uplink's capacity per direct child, and the viewers' median (kbps), when known. */
  uplinkPerChildKbps: number | null
  medianPeerKbps: number | null
  /** It comes from the browser's estimates: the controller goes straight to it. */
  estimated?: boolean
}

/** The bitrate the stream should run at, and why. */
export function rateTarget(i: RateInputs): RateTarget {
  const children = i.directChildren > 0
  const perChild = children && i.uplinkKbps !== null ? i.uplinkKbps / i.directChildren : null
  const median = children ? upperMedian(i.peerKbps.map((x) => x ?? Infinity)) : Infinity
  const medianPeerKbps = Number.isFinite(median) ? median : null
  // With the browser's estimates, the uplink's share per child doesn't bind once most children are
  // known: the estimates' sum over the children is their mean, which one slow viewer drags down,
  // and a shared bottleneck shows in each child's estimate anyway (their GCCs split it).
  const byMedian = !!i.estimated && medianPeerKbps !== null
  // The uplink's own shaper (the up= debug cap) is a hard limit no estimate sees: its share always binds.
  const capPerChild = children && i.uplinkCapKbps != null ? i.uplinkCapKbps / i.directChildren : Infinity
  const share = Math.min(byMedian ? Infinity : (perChild ?? Infinity), capPerChild)
  const wire = Math.min(share, median)
  let kbps = i.chosenKbps
  let limit: RateLimit = 'chosen'
  if (Number.isFinite(wire)) {
    const v = TARGET_SHARE * videoKbpsForWire(wire, i.wireAt)
    if (v < kbps) {
      kbps = v
      limit = medianPeerKbps !== null && medianPeerKbps < share ? 'viewers' : 'uplink'
    }
  }
  // Nothing known, of the uplink or of every child: start gently.
  const unknown = i.uplinkKbps === null && i.peerKbps.some((x) => x === null)
  if (children && unknown && START_KBPS < kbps) {
    kbps = START_KBPS
    limit = 'unmeasured'
  }
  if (i.audienceKbps !== null && i.audienceKbps < kbps) {
    kbps = i.audienceKbps
    limit = 'audience'
  }
  const estimated = byMedian && (limit === 'chosen' || limit === 'viewers')
  return { kbps, limit, uplinkPerChildKbps: perChild, medianPeerKbps, estimated }
}

/** Paces moves towards the target (see the top of the file). */
export class BitrateController {
  private lastDown = -Infinity
  private lastUp = -Infinity
  /** The last target was START_KBPS for want of a measurement. */
  private unmeasured = false

  /**
   * The next bitrate, or null to stay. `fastDropAt`: when a measured capacity last fell at once
   * (CapacityModel): one since the last cut lets this cut go all the way to the target.
   */
  step(now: number, currentKbps: number, t: RateTarget, o: { fastDropAt?: number } = {}): number | null {
    const wasUnmeasured = this.unmeasured
    this.unmeasured = t.limit === 'unmeasured'
    // The first measurement: straight to its target, which is as safe as any measured one.
    if (wasUnmeasured && !this.unmeasured && t.kbps > currentKbps) {
      this.lastUp = now
      return t.kbps
    }
    if (t.kbps < currentKbps * (1 - DEADBAND)) {
      if (now - this.lastDown < DOWN_GAP_MS) return null
      // The browser's estimate fell (20 → 3 Mbps): it already reflects the loss or delay it saw.
      const steep = t.estimated || (o.fastDropAt ?? -Infinity) > this.lastDown || this.unmeasured
      this.lastDown = now
      return steep ? t.kbps : Math.max(t.kbps, currentKbps * MAX_CUT)
    }
    // Back to the chosen quality even from just below it; elsewhere small moves are noise.
    const up = t.kbps > currentKbps * (1 + DEADBAND) || (t.limit === 'chosen' && t.kbps > currentKbps)
    if (!up) return null
    if (t.estimated) {
      // The estimate grew (GCC grows only to about 1.5 times what is sent, so this climbs in steps).
      if (now - this.lastUp < DOWN_GAP_MS || now - this.lastDown < DOWN_GAP_MS) return null
      this.lastUp = now
      return t.kbps
    }
    if (now - this.lastUp < UP_GAP_MS || now - this.lastDown < UP_GAP_MS) return null
    this.lastUp = now
    return Math.min(t.kbps, currentKbps * UP_STEP)
  }

  /** Straight to the target (JumpGate said so). */
  jump(now: number, t: RateTarget): number {
    this.unmeasured = t.limit === 'unmeasured'
    this.lastUp = now
    return t.kbps
  }
}

/**
 * When the bitrate may go straight up to its target instead of 25% per 10 s:
 *   - after the chosen quality went up, once a probe no older than PROBE_FRESH_MS confirms the
 *     uplink carries it (asking for one if there is none: `probeWanted`). Until then the stream
 *     stays where it was rather than sending the new quality, and its keyframe, into an
 *     unverified link;
 *   - after a cut, once a probe since shows capacity is back (one that shows it isn't ends it too).
 * With no direct children there is nothing to overload: at once.
 */
export class JumpGate {
  private ceiling = 0
  /** A probe at or after this confirms the pending jump; null with none pending. */
  private after: number | null = null
  /** The pending jump is a raised quality, which asks for a probe. */
  private raised = false
  /** A probe now would confirm a pending jump (PeerSession runs one). */
  probeWanted = false

  /** One window: whether to jump to the target now. `probedAt`: CapacityModel.probedAt. */
  step(now: number, o: { ceilingKbps: number; currentKbps: number; targetKbps: number; probedAt: number; children: boolean }): boolean {
    if (o.ceilingKbps > this.ceiling) {
      this.after = now - PROBE_FRESH_MS
      this.raised = true
    }
    this.ceiling = o.ceilingKbps
    const up = o.targetKbps > o.currentKbps
    if (this.after !== null && (!o.children || o.probedAt >= this.after)) {
      this.after = null
      this.raised = false
      this.probeWanted = false
      return up
    }
    this.probeWanted = this.after !== null && this.raised && up
    return false
  }

  /** The bitrate was cut: a probe after now may lift it straight back. */
  cut(now: number): void {
    this.after = now
    this.raised = false
    this.probeWanted = false
  }
}

/** Auto quality: at most one cut to what the audience can carry per this long (ms). */
export const AUDIENCE_CUT_GAP_MS = 30_000
/** ...and the cut is lifted once the audience has carried the stream this long (ms). */
export const AUDIENCE_LIFT_MS = 30_000

/**
 * Auto quality ("Lower automatically"): while the audience's relay slots can't carry the stream
 * (ChannelPublisher.limited), cap the bitrate at what they can carry. It is kept apart from the
 * chosen quality, which stays the ceiling: once the audience has carried the stream for
 * AUDIENCE_LIFT_MS the cap is lifted, and BitrateController climbs back at its own pace (held
 * where the audience runs short again by `audienceLimit`).
 */
export class AudienceCap {
  /** The cap (kbps), or null. */
  kbps: number | null = null
  private lastCut = -Infinity
  private fineSince: number | null = null

  /** One check, with Auto quality on or off, and the publisher's feasibility verdict. */
  step(now: number, auto: boolean, limited: { feasibleKbps: number } | null, chosenKbps: number): number | null {
    if (!auto) {
      this.kbps = null
      this.fineSince = null
      return null
    }
    if (limited) {
      this.fineSince = null
      if (now - this.lastCut >= AUDIENCE_CUT_GAP_MS && limited.feasibleKbps < Math.min(this.kbps ?? Infinity, chosenKbps)) {
        this.kbps = limited.feasibleKbps
        this.lastCut = now
      }
    } else if (this.kbps !== null) {
      this.fineSince ??= now
      if (now - this.fineSince >= AUDIENCE_LIFT_MS) {
        this.kbps = null
        this.fineSince = null
      }
    }
    return this.kbps
  }
}

/**
 * The `audienceKbps` input of rateTarget: the Auto quality cap, and, while the audience is short,
 * no climbing past the current bitrate (or what it could carry, if more).
 */
export function audienceLimit(capKbps: number | null, limited: { feasibleKbps: number } | null, currentKbps: number): number | null {
  const hold = limited ? Math.max(limited.feasibleKbps, currentKbps) : null
  if (capKbps === null) return hold
  return hold === null ? capKbps : Math.min(capKbps, hold)
}
