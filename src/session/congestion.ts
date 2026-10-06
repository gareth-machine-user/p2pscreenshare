// A presenter's video bitrate, from measured capacity (session/capacity.ts CapacityModel). Pure, so
// it can be simulated in tests; PeerSession calls it once per 2 s window.
//
// The stream needs one full copy (every stripe, parity included) per direct child, so the wire
// budget per child is the smaller of
//   - the uplink's capacity shared by the direct children, and
//   - the median capacity of the peers it feeds directly (scaled to a full copy for a peer fed
//     only some stripes), so one slow viewer can't hold everyone else down: it sheds enhancement
//     layers on its own link, and Auto quality can show it the preview;
// and the target is 85% of the video bitrate that budget carries (stripeKbpsFor's overhead), never
// above the chosen quality or what the audience's relay slots can carry.
//
// Pacing: down at once (at most every 4 s), up by at most 25% per 10 s; changes under 5% are noise.
// With nothing measured yet, it keeps the chosen quality.

/** Settle at this share of what the wire budget carries. */
export const TARGET_SHARE = 0.85
/** At most one cut per this long (ms). */
export const DOWN_GAP_MS = 4000
/** At most one raise per this long (ms), and none this soon after a cut. */
export const UP_GAP_MS = 10_000
/** A raise is at most this factor. */
export const UP_STEP = 1.25
/** Changes smaller than this share are ignored. */
export const DEADBAND = 0.05

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
  /** The uplink's capacity (kbps), null until measured. */
  uplinkKbps: number | null
  /** (child, stripe) edges from the publisher / stripes. */
  directChildren: number
  /**
   * Per peer fed directly: the full-copy wire rate its connections carry (kbps), or null when none
   * of them has been its own bottleneck (it can take more than it is sent).
   */
  peerKbps: (number | null)[]
  /** Wire kbps of one full copy (every stripe) at a video bitrate. */
  wireAt: (videoKbps: number) => number
}

export type RateLimit = 'chosen' | 'uplink' | 'viewers' | 'audience'

export interface RateTarget {
  kbps: number
  /** What sets it. */
  limit: RateLimit
  /** The uplink's capacity per direct child, and the viewers' median (kbps), when known. */
  uplinkPerChildKbps: number | null
  medianPeerKbps: number | null
}

/** The bitrate the stream should run at, and why. */
export function rateTarget(i: RateInputs): RateTarget {
  const children = i.directChildren > 0
  const perChild = children && i.uplinkKbps !== null ? i.uplinkKbps / i.directChildren : null
  const median = children ? upperMedian(i.peerKbps.map((x) => x ?? Infinity)) : Infinity
  const medianPeerKbps = Number.isFinite(median) ? median : null
  const wire = Math.min(perChild ?? Infinity, median)
  let kbps = i.chosenKbps
  let limit: RateLimit = 'chosen'
  if (Number.isFinite(wire)) {
    const v = TARGET_SHARE * videoKbpsForWire(wire, i.wireAt)
    if (v < kbps) {
      kbps = v
      limit = medianPeerKbps !== null && medianPeerKbps < (perChild ?? Infinity) ? 'viewers' : 'uplink'
    }
  }
  if (i.audienceKbps !== null && i.audienceKbps < kbps) {
    kbps = i.audienceKbps
    limit = 'audience'
  }
  return { kbps, limit, uplinkPerChildKbps: perChild, medianPeerKbps }
}

/** Paces moves towards the target (see the top of the file). */
export class BitrateController {
  private lastDown = -Infinity
  private lastUp = -Infinity

  /** The next bitrate, or null to stay. */
  step(now: number, currentKbps: number, t: RateTarget): number | null {
    if (t.kbps < currentKbps * (1 - DEADBAND)) {
      if (now - this.lastDown < DOWN_GAP_MS) return null
      this.lastDown = now
      return t.kbps
    }
    // Back to the chosen quality even from just below it; elsewhere small moves are noise.
    const up = t.kbps > currentKbps * (1 + DEADBAND) || (t.limit === 'chosen' && t.kbps > currentKbps)
    if (!up || now - this.lastUp < UP_GAP_MS || now - this.lastDown < UP_GAP_MS) return null
    this.lastUp = now
    return Math.min(t.kbps, currentKbps * UP_STEP)
  }
}
