// Congestion control for a presenter's video bitrate. Pure (no timers, no WebRTC), so it can be
// simulated in tests; PeerSession feeds it one sample per uplink stats window (2 s).
//
// The old policy cut by 25% (halved when swamped) and climbed back by 25% every 5 s. On a single
// WebRTC connection whose SCTP congestion control tops out below the chosen quality, that
// oscillates: climb into the ceiling, queue for seconds, halve, climb again. This controller
// instead estimates the sustainable rate from what the uplink actually sent while congested and
// settles just below it:
//
// - Down: target ≈ 90% of the sustainable video rate (never above 90% nor below 50% of the
//   current rate). The sustainable video rate is the one at which this stream's wire rate plus
//   the uplink's other traffic equals what was sent. If what was sent says nothing (≈ 0, or no
//   more than the other traffic), it falls back to a blind cut: by 25%, or by half when swamped.
//   Right after a cut the backlog takes a while to drain; while it shrinks, no further cut.
// - Up: after 5 s clean, back to 95% of the rate at which the uplink filled (the ceiling hint) in
//   one step (at most +50%), then probe above it by 5% every 10 s. The hint expires after a
//   minute clean, after which the controller climbs by 25% every 5 s as before.
//
// Assumptions, for the wire-to-video conversion:
// - This stream's wire rate is `ownWireKbpsAt(video)`: one stripe copy per direct child at the
//   nominal stripe rate (stripeKbpsFor: video / k × 1.05 + per-stripe framing, signatures, audio).
// - The rest of the uplink (the preview channel, relaying other channels, probes, encoder
//   overshoot) is "other" traffic, measured on clean samples as sent − own nominal wire rate
//   (smoothed, never below 0) and assumed to keep its rate while congested. The uplink actually
//   round-robins links, so other traffic gives up some of its share too: the estimate errs low.
// - An encoder that undershoots its target makes the own wire rate look larger than it is, so the
//   estimate again errs low (the probing climb recovers the difference).

export interface CongestionConfig {
  /** At most one cut per this long (ms). */
  downGapMs: number
  /** Settle at this share of the estimated sustainable rate. */
  targetShare: number
  /** A cut takes the rate to at most this share of the current rate... */
  minCut: number
  /** ...and at least this share. */
  maxCut: number
  /** Blind cut (the measured rate says nothing), and the blind cut when clearly swamped. */
  blindDown: number
  severeDown: number
  severeDropsPerS: number
  /** Queueing above this is swamped (twice the back-off threshold, tuning.ccQueueMs). */
  severeQueueMs: number
  /** After a cut, no further cut while the backlog drains, for at most this long (ms). */
  drainMs: number
  /** Already below the estimate and still not draining: the estimate was wrong; cut by this. */
  stuckDown: number
  /** Climb only after this long clean, and at most this often (ms). */
  upAfterMs: number
  /** Without a ceiling hint: climb by this factor every upAfterMs. */
  up: number
  /** With a hint: return to this share of it in one step (at most `resumeMaxStep` × current)... */
  resumeShare: number
  resumeMaxStep: number
  /**
   * ...then probe above it by this factor every probeGapMs. Each time the uplink fills again
   * within `sameCeiling` of the hint, the gap doubles (up to probeGapMaxMs): a ceiling that holds
   * is probed less and less often.
   */
  probeStep: number
  probeGapMs: number
  probeGapMaxMs: number
  sameCeiling: number
  /** The hint expires after this long clean (ms), or three probe gaps if longer. */
  hintTtlMs: number
  /**
   * The first climb after a hint expires: gentler than `up`, since the ceiling may well still be
   * there (a full +25% would overshoot it). Later climbs use `up` again.
   */
  upAfterExpiry: number
  /** Smoothing of the other-traffic estimate (weight of the newest clean sample)... */
  otherAlpha: number
  /**
   * Quiet: queueing below this (ms). Other traffic is measured only while quiet (a backlog
   * draining or building up isn't other traffic); probing above the hint, and the hint's expiry
   * clock, also wait for quiet.
   */
  quietQueueMs: number
}

export const CONGESTION_DEFAULTS: CongestionConfig = {
  downGapMs: 4000,
  targetShare: 0.9,
  minCut: 0.9,
  maxCut: 0.5,
  blindDown: 0.75,
  severeDown: 0.5,
  severeDropsPerS: 50,
  severeQueueMs: 1600,
  drainMs: 12_000,
  stuckDown: 0.85,
  upAfterMs: 5000,
  up: 1.25,
  resumeShare: 0.95,
  resumeMaxStep: 1.5,
  probeStep: 1.05,
  probeGapMs: 10_000,
  probeGapMaxMs: 40_000,
  sameCeiling: 0.15,
  hintTtlMs: 60_000,
  upAfterExpiry: 1.08,
  otherAlpha: 0.3,
  quietQueueMs: 100,
}

/** One uplink stats window. */
export interface CongestionSample {
  now: number
  /** The uplink itself is full (capacity.ts uplinkIsFull). */
  full: boolean
  /** What the whole uplink sent over the window (wire kbps). */
  sentKbps: number
  /** The stream's current video bitrate (kbps). */
  currentKbps: number
  /** Never above this: the chosen quality, or what the audience's relay slots can carry. */
  maxKbps: number
  /** Live fragments dropped per second, and the average queueing of sent ones (ms). */
  dropsPerS: number
  queueMs: number
  /** This stream's own wire rate at a given video bitrate (all copies the presenter sends). */
  ownWireKbpsAt: (videoKbps: number) => number
}

export interface CongestionDecision {
  kbps: number
  /** Why, in words (shown in Stats). */
  reason: string
}

/** Bitrates are changed in steps of 50 kbps (publisher.ts); smaller moves are noise. */
const MIN_CHANGE_KBPS = 50
/** The encoder's floor (publisher.ts MIN_ADAPTIVE_KBPS). */
const FLOOR_KBPS = 300
/** What was sent is no estimate below this share of the stream's demand. */
const UNRELIABLE_SHARE = 0.05

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(1)} Mbps`

/** The video bitrate at which `wire(video)` reaches `wireKbps` (wire is increasing in video). */
export function videoKbpsForWire(wireKbps: number, wire: (videoKbps: number) => number): number {
  if (wire(0) >= wireKbps) return 0
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

export class CongestionController {
  /** Uplink traffic other than this stream (kbps, smoothed over clean samples). */
  otherKbps = 0
  /** The sustainable video rate last estimated while congested, and when. */
  hint: { kbps: number; at: number } | null = null
  /** What the uplink sent while full (kbps): shown as the reason for a clamp. */
  sendingKbps: number | null = null
  private lastDown = -Infinity
  private lastUp = -Infinity
  private cleanSince: number | null = null
  private quietSince: number | null = null
  private lastFull: { at: number; queueMs: number; drops: number; sent: number } | null = null
  /** Current gap between probes above the hint (doubles each time the same ceiling is hit). */
  private probeGapMs: number
  /** A hint just expired: the next climb is gentle (upAfterExpiry). */
  private gentleNext = false

  constructor(readonly cfg: CongestionConfig = CONGESTION_DEFAULTS) {
    this.probeGapMs = cfg.probeGapMs
  }

  sample(s: CongestionSample): CongestionDecision | null {
    return s.full ? this.congested(s) : this.clean(s)
  }

  private congested(s: CongestionSample): CongestionDecision | null {
    const c = this.cfg
    const prev = this.lastFull
    this.cleanSince = null
    this.quietSince = null
    // Consecutive full windows: one that sent less (a stall) doesn't erase what the last one saw.
    const recent = prev && s.now - prev.at <= 2 * c.downGapMs
    const sent = Math.max(s.sentKbps, recent ? prev.sent * 0.8 : 0)
    this.lastFull = { at: s.now, queueMs: s.queueMs, drops: s.dropsPerS, sent }
    this.sendingKbps = sent
    const ownSent = sent - this.otherKbps
    const demand = s.ownWireKbpsAt(s.currentKbps)
    const reliable = ownSent > demand * UNRELIABLE_SHARE && ownSent > 0
    const est = reliable ? Math.min(s.currentKbps, videoKbpsForWire(sent - this.otherKbps, s.ownWireKbpsAt)) : null
    // Only a rate the uplink couldn't carry says where its ceiling is (not a backlog draining
    // below it). The same ceiling again: probe above it less often.
    if (est !== null && est < s.currentKbps) this.setHint(est, s.now)

    if (s.now - this.lastDown < c.downGapMs || s.currentKbps <= FLOOR_KBPS) return null
    const severe = s.dropsPerS > c.severeDropsPerS || s.queueMs > c.severeQueueMs
    let target: number
    let why: string
    if (est === null) {
      target = s.currentKbps * (severe ? c.severeDown : c.blindDown)
      why = severe ? 'swamped, halving' : 'backing off'
    } else if (s.currentKbps * c.minCut <= est * c.targetShare) {
      // Already at or below the settling point: the backlog of the previous rate is draining.
      const draining = prev !== null && (s.queueMs < prev.queueMs * 0.95 || s.dropsPerS < prev.drops * 0.8)
      if (draining && s.now - this.lastDown < c.drainMs) return null
      // Not draining: the estimate was too high (untracked traffic, a worse path).
      target = s.currentKbps * c.stuckDown
      this.setHint(target / c.targetShare, s.now)
      why = `still congested at ${mbps(s.currentKbps)}`
    } else {
      target = Math.max(s.currentKbps * c.maxCut, Math.min(s.currentKbps * c.minCut, est * c.targetShare))
      why = `the uplink carries about ${mbps(sent)}, settling at ${mbps(target)}`
    }
    target = Math.max(FLOOR_KBPS, target)
    if (s.currentKbps - target < MIN_CHANGE_KBPS) return null
    this.lastDown = s.now
    return { kbps: target, reason: why }
  }

  private setHint(kbps: number, now: number): void {
    const c = this.cfg
    const same = this.hint !== null && Math.abs(kbps - this.hint.kbps) <= this.hint.kbps * c.sameCeiling
    this.probeGapMs = same ? Math.min(c.probeGapMaxMs, this.probeGapMs * 2) : c.probeGapMs
    this.hint = { kbps, at: now }
  }

  private clean(s: CongestionSample): CongestionDecision | null {
    const c = this.cfg
    const cleanSince = (this.cleanSince ??= s.now)
    const quiet = s.queueMs < c.quietQueueMs
    this.quietSince = quiet ? (this.quietSince ?? s.now) : null
    if (s.sentKbps > 0 && quiet) {
      const other = Math.max(0, s.sentKbps - s.ownWireKbpsAt(s.currentKbps))
      this.otherKbps += (other - this.otherKbps) * c.otherAlpha
    }
    if (this.hint && this.quietSince !== null && s.now - this.quietSince >= Math.max(c.hintTtlMs, 3 * this.probeGapMs)) {
      this.hint = null
      this.probeGapMs = c.probeGapMs
      this.gentleNext = true
    }
    if (s.currentKbps >= s.maxKbps || s.now - cleanSince < c.upAfterMs || s.now - this.lastUp < c.upAfterMs) return null
    let target: number
    let why: string
    const hint = this.hint
    if (!hint) {
      // Only while the queue is near-empty: a small overshoot shows up as a growing queue well
      // before it counts as congestion, and climbing again on top of it would compound it.
      if (!quiet) return null
      target = s.currentKbps * (this.gentleNext ? c.upAfterExpiry : c.up)
      why = this.gentleNext ? 'no congestion for a while, trying a little higher' : 'no congestion for 5 s'
    } else if (s.currentKbps < hint.kbps * c.resumeShare - MIN_CHANGE_KBPS) {
      target = Math.min(hint.kbps * c.resumeShare, s.currentKbps * c.resumeMaxStep)
      why = `back towards ${mbps(hint.kbps)}, where the uplink filled`
    } else {
      // Probing past where the uplink filled: one step per gap, and not while a queue is building.
      if (s.now - this.lastUp < this.probeGapMs || !quiet) return null
      target = s.currentKbps * c.probeStep
      why = `probing above ${mbps(hint.kbps)}`
    }
    target = Math.min(target, s.maxKbps)
    if (target - s.currentKbps < MIN_CHANGE_KBPS && target < s.maxKbps) return null
    if (target <= s.currentKbps) return null
    this.lastUp = s.now
    this.gentleNext = false
    return { kbps: target, reason: why }
  }
}
