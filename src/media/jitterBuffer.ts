import { NO_REF } from '../proto/framing'
import type { AssembledFrame } from './reassembler'
import { SortedWindow } from './sortedWindow'
import { tuning } from '../tuning'

export interface PlayoutClockOptions {
  /** Fraction of frames that should arrive before their render time. */
  quantile: number
  safetyMs: number
  windowMs: number
  minDelayMs: number
  maxDelayMs: number
  /** Max change of the playout delay per second of wall time (avoids visible jumps); it rises 4x faster. */
  slewMsPerSec: number
  /** Max fall of the playout delay per second (defaults to slewMsPerSec). */
  slewDownMsPerSec?: number
  /**
   * How long the largest recent buffer is kept after the spike that needed it (ms). A connection
   * that hiccups every half minute would otherwise shrink its buffer between hiccups (the transit
   * window is only a few seconds) and stall on each one.
   */
  holdMs: number
  /** Added on top of the computed buffer (the viewer's "extra smooth" choice). */
  extraMs: number
}

/**
 * The viewer's playback buffering choice: `low` plays as early as the network allows (more
 * stalls), `auto` adapts to the connection, `extra` adds a fixed cushion on top for flaky ones.
 */
export type Buffering = 'low' | 'auto' | 'extra'
export const BUFFERINGS: readonly Buffering[] = ['low', 'auto', 'extra']
/** The cushion `extra` adds (ms). */
export const EXTRA_BUFFER_MS = 1500

const QUALITY = tuning.priority === 'quality'
const DEFAULT_CLOCK: PlayoutClockOptions = {
  quantile: tuning.playoutQuantile,
  safetyMs: tuning.playoutSafetyMs,
  windowMs: 8000,
  minDelayMs: tuning.playoutMinDelayMs,
  maxDelayMs: 4500,
  slewMsPerSec: 250,
  // Quality: shrink more slowly than the audio playout can speed up (1%, 10 ms/s), so audio
  // follows smoothly instead of skipping ahead, and keep a spike's buffer for a minute.
  slewDownMsPerSec: QUALITY ? 8 : 250,
  holdMs: QUALITY ? 60_000 : 5000,
  extraMs: 0,
}

/** What a buffering choice changes from the clock's base options. */
export function bufferingOptions(b: Buffering): Partial<PlayoutClockOptions> {
  if (b === 'low') return { quantile: 0.95, safetyMs: 40, minDelayMs: 30, holdMs: 0, slewDownMsPerSec: 250 }
  if (b === 'extra') return { extraMs: EXTRA_BUFFER_MS }
  return {}
}

/**
 * Maps host capture timestamps to local render times without needing synchronized clocks.
 * "transit" samples are (local completion time - host capture time), which include the clock
 * offset; rendering at captureTime + quantile(transit) + safety plays ~quantile of frames on time.
 */
export class PlayoutClock {
  /** Transit samples of the last windowMs, kept sorted (a few hundred, updated on every frame). */
  private samples = new SortedWindow()
  private delay: number | null = null
  private target = 0
  private lastUpdate = 0
  private opts: PlayoutClockOptions
  private readonly base: PlayoutClockOptions
  /** The largest buffer needed lately (beyond the fastest path) and when it was last needed. */
  private peak: { extra: number; at: number } | null = null

  constructor(opts: Partial<PlayoutClockOptions> = {}) {
    this.base = { ...DEFAULT_CLOCK, ...opts }
    this.opts = this.base
  }

  /**
   * Switches buffering. Going lower jumps straight to the new target: the viewer asked for less
   * delay, so a skip is better than minutes of gliding down.
   */
  setBuffering(b: Buffering): void {
    this.opts = { ...this.base, ...bufferingOptions(b) }
    this.peak = null
    const now = this.lastUpdate
    this.recompute(now)
    if (this.delay !== null && this.target < this.delay) this.delay = this.target
  }

  addSample(captureTime: number, completedAt: number): void {
    const transit = completedAt - captureTime
    // A NaN would corrupt the sorted window for good.
    if (!Number.isFinite(transit)) return
    this.samples.add(completedAt, transit)
    this.samples.expire(completedAt - this.opts.windowMs)
    this.recompute(completedAt)
  }

  private recompute(now: number): void {
    if (!this.samples.size) return
    const minT = this.samples.min!
    const q = this.samples.quantile(this.opts.quantile)!
    // Express bounds relative to the fastest observed transit (absolute offset is unknown).
    let extra = Math.min(Math.max(q - minT + this.opts.safetyMs, this.opts.minDelayMs), this.opts.maxDelayMs)
    // Keep the largest recent need for holdMs after it was last needed.
    if (!this.peak || extra >= this.peak.extra || now - this.peak.at > this.opts.holdMs) this.peak = { extra, at: now }
    extra = Math.max(extra, this.peak.extra) + this.opts.extraMs
    this.target = minT + extra
    if (this.delay === null) {
      this.delay = this.target
    } else {
      const dt = Math.max(0, now - this.lastUpdate) / 1000
      const up = this.opts.slewMsPerSec * 4 * dt
      const down = (this.opts.slewDownMsPerSec ?? this.opts.slewMsPerSec) * dt
      // Increase quickly (avoid stalls), decrease slowly.
      const step = this.target > this.delay ? Math.min(this.target - this.delay, up) : -Math.min(this.delay - this.target, down)
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
    if (this.delay === null || !this.samples.size) return 0
    return this.delay - this.samples.min!
  }

  get ready(): boolean {
    return this.delay !== null
  }
}

/**
 * Most frames the decode scheduler holds. Normal playback holds at most the playout delay's worth
 * (a few hundred frames at 60 fps); this bounds the buffer while it waits for a keyframe that is
 * slow to come, or while nothing polls it (a decoder that failed to configure).
 */
export const MAX_BUFFERED_FRAMES = 1024

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
    /**
     * Replayed (GOP-cache) frames are already past their render time and arrive in bursts from
     * several stripe parents, out of order; wait this long after the next available replayed
     * frame arrived before skipping a missing one.
     */
    private replayReorderMs = 100,
  ) {}

  push(frame: AssembledFrame): void {
    // While the chain is broken, a replayed GOP (requested from the stripe parents) restarts it
    // from its keyframe, which is older than what was already decoded. Otherwise replayed frames
    // behind the decode position are repeats of frames already handled, not late ones.
    if (this.nextSeq !== null && frame.seq < this.nextSeq && !(frame.replay && this.needKey)) {
      if (!frame.replay) this.stats.droppedLate++
      return
    }
    this.buffer.set(frame.seq, frame)
    if (this.buffer.size > MAX_BUFFERED_FRAMES) this.dropOldest(this.buffer.size - MAX_BUFFERED_FRAMES)
  }

  /** Drops the `n` lowest-numbered buffered frames. */
  private dropOldest(n: number): void {
    const seqs = [...this.buffer.keys()].sort((a, b) => a - b)
    for (const s of seqs.slice(0, n)) {
      this.buffer.delete(s)
      this.stats.droppedUndecodable++
    }
  }

  /** Forces a wait for the next keyframe (e.g. after a decoder reset). */
  requireKeyframe(): void {
    if (!this.needKey) this.breakChain()
  }

  /**
   * Forgets buffered frames and decode history and waits for a keyframe (a new decoder). Requests a
   * keyframe unless `requestKey` is false (e.g. the caller is about to supply one).
   */
  reset(requestKey = true): void {
    this.buffer.clear()
    this.decoded.clear()
    this.nextSeq = null
    this.needKey = true
    if (requestKey) this.onNeedKeyframe()
  }

  get waitingForKeyframe(): boolean {
    return this.needKey
  }

  /**
   * Returns frames to feed to the decoder now, in order. Frames due more than `decodeAheadMs`
   * from now stay encoded here: decoded frames hold decoder output buffers until shown, and a
   * multi-second jitter buffer of them starves the decoder.
   */
  poll(now: number, decodeAheadMs = Infinity): AssembledFrame[] {
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
        const fDue = this.clock.renderAt(f.captureTime)
        if (fDue !== null && fDue - now > decodeAheadMs) break
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
      if (laterFrame.replay && now - laterFrame.completedAt < this.replayReorderMs) break
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
