import { NO_REF } from '../proto/framing'
import type { AssembledFrame } from './reassembler'
import { tuning } from '../tuning'

export interface PlayoutClockOptions {
  /** Fraction of frames that should arrive before their render time. */
  quantile: number
  safetyMs: number
  windowMs: number
  minDelayMs: number
  maxDelayMs: number
  /** Max change of the playout delay per second of wall time (avoids visible jumps). */
  slewMsPerSec: number
}

const DEFAULT_CLOCK: PlayoutClockOptions = {
  quantile: tuning.playoutQuantile,
  safetyMs: tuning.playoutSafetyMs,
  windowMs: 8000,
  minDelayMs: tuning.playoutMinDelayMs,
  maxDelayMs: 4500,
  slewMsPerSec: 250,
}

/**
 * Maps host capture timestamps to local render times without needing synchronized clocks.
 * "transit" samples are (local completion time - host capture time), which include the clock
 * offset; rendering at captureTime + quantile(transit) + safety plays ~quantile of frames on time.
 */
export class PlayoutClock {
  private samples: { at: number; transit: number }[] = []
  private delay: number | null = null
  private target = 0
  private lastUpdate = 0
  private opts: PlayoutClockOptions

  constructor(opts: Partial<PlayoutClockOptions> = {}) {
    this.opts = { ...DEFAULT_CLOCK, ...opts }
  }

  addSample(captureTime: number, completedAt: number): void {
    this.samples.push({ at: completedAt, transit: completedAt - captureTime })
    const cutoff = completedAt - this.opts.windowMs
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift()
    this.recompute(completedAt)
  }

  private recompute(now: number): void {
    if (!this.samples.length) return
    const sorted = this.samples.map((s) => s.transit).sort((a, b) => a - b)
    const minT = sorted[0]
    const q = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * this.opts.quantile))]
    // Express bounds relative to the fastest observed transit (absolute offset is unknown).
    const extra = Math.min(
      Math.max(q - minT + this.opts.safetyMs, this.opts.minDelayMs),
      this.opts.maxDelayMs,
    )
    this.target = minT + extra
    if (this.delay === null) {
      this.delay = this.target
    } else {
      const dt = Math.max(0, now - this.lastUpdate) / 1000
      const maxStep = this.opts.slewMsPerSec * dt
      // Increase quickly (avoid stalls), decrease slowly.
      const step = this.target > this.delay ? Math.min(this.target - this.delay, maxStep * 4) : -Math.min(this.delay - this.target, maxStep)
      this.delay += step
    }
    this.lastUpdate = now
  }

  /** Local time at which a frame captured at `captureTime` should be shown. */
  renderAt(captureTime: number): number | null {
    return this.delay === null ? null : captureTime + this.delay
  }

  /** Current playout delay beyond the fastest observed path (ms). */
  get bufferMs(): number {
    if (this.delay === null || !this.samples.length) return 0
    let minT = Infinity
    for (const s of this.samples) minT = Math.min(minT, s.transit)
    return this.delay - minT
  }

  get ready(): boolean {
    return this.delay !== null
  }
}

export interface SchedulerStats {
  decoded: number
  droppedLate: number
  droppedUndecodable: number
  skippedMissing: number
}

/**
 * Orders video frames for decoding and enforces reference dependencies, so partial delivery
 * (e.g. dropped temporal-enhancement frames) never feeds the decoder an undecodable frame.
 */
export class DecodeScheduler {
  private buffer = new Map<number, AssembledFrame>()
  private decoded = new Set<number>()
  private nextSeq: number | null = null
  private needKey = true
  stats: SchedulerStats = { decoded: 0, droppedLate: 0, droppedUndecodable: 0, skippedMissing: 0 }

  constructor(
    private clock: PlayoutClock,
    /** Called when the decode chain is broken and a keyframe is needed. */
    private onNeedKeyframe: () => void = () => {},
    /** Give up on a missing frame once the next available frame is this close to its render time. */
    private giveUpMarginMs = 15,
  ) {}

  push(frame: AssembledFrame): void {
    if (this.nextSeq !== null && frame.seq < this.nextSeq) {
      this.stats.droppedLate++
      return
    }
    this.buffer.set(frame.seq, frame)
  }

  /** Forces a wait for the next keyframe (e.g. after a decoder reset). */
  requireKeyframe(): void {
    if (!this.needKey) this.breakChain()
  }

  get waitingForKeyframe(): boolean {
    return this.needKey
  }

  /** Returns frames to feed to the decoder now, in order. */
  poll(now: number): AssembledFrame[] {
    const out: AssembledFrame[] = []
    for (;;) {
      if (this.needKey) {
        const key = this.earliestKey()
        if (key === null) break
        this.dropBefore(key)
        this.nextSeq = key
        this.needKey = false
        this.decoded.clear()
      }
      if (this.nextSeq === null) break

      const f = this.buffer.get(this.nextSeq)
      if (f) {
        this.buffer.delete(f.seq)
        this.nextSeq++
        if (f.key || (f.refSeq !== NO_REF && this.decoded.has(f.refSeq))) {
          this.decoded.add(f.seq)
          if (this.decoded.size > 512) this.decoded.delete(this.decoded.values().next().value!)
          this.stats.decoded++
          out.push(f)
        } else {
          this.stats.droppedUndecodable++
          // T0 and T1 frames reference a T0 frame, so the base chain is broken.
          if (f.layer <= 1) this.breakChain()
        }
        continue
      }

      // nextSeq is missing: wait unless a later frame is about to be due.
      const later = this.earliestAfter(this.nextSeq)
      if (later === null) break
      const laterFrame = this.buffer.get(later)!
      const due = this.clock.renderAt(laterFrame.captureTime)
      if (due !== null && due - now > this.giveUpMarginMs) break
      this.stats.skippedMissing += later - this.nextSeq
      this.nextSeq = later
      // A missing frame may have been a reference; dependency checks on later frames handle it.
    }
    return out
  }

  private breakChain(): void {
    this.needKey = true
    this.onNeedKeyframe()
  }

  private earliestKey(): number | null {
    let best: number | null = null
    for (const [seq, f] of this.buffer) if (f.key && (best === null || seq < best)) best = seq
    return best
  }

  private earliestAfter(seq: number): number | null {
    let best: number | null = null
    for (const s of this.buffer.keys()) if (s > seq && (best === null || s < best)) best = s
    return best
  }

  private dropBefore(seq: number): void {
    for (const s of this.buffer.keys()) {
      if (s < seq) {
        this.buffer.delete(s)
        this.stats.droppedUndecodable++
      }
    }
  }

  get buffered(): number {
    return this.buffer.size
  }
}
