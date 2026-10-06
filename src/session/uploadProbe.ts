// The upload probe: measures this peer's upload by sending to a few neighbours in parallel, and
// answers neighbours' probes (bytes received over the arrival window).
//
// A presenter's tab is usually hidden while it shares another window, and hidden tabs' timers are
// throttled. So probe sends are driven by the probe channels' buffer-low events (with the worker
// ticker as a backstop) and the probe ends on the worker ticker: neither is throttled, so a hidden
// tab measures normally. A probe whose sending was starved anyway is discarded rather than taken as
// a (far too low) estimate.
import type { ProbeLink } from '../net/link'
import { after, every, sleep } from '../net/ticker'
import { REPLAY_BUFFER_MAX } from '../net/uplink'
import type { PeerMsg } from '../proto/messages'

export const PROBE_DURATION_MS = 1500
export const PROBE_CHUNK = 16 * 1024
const PROBE_PEERS = 3
const PROBE_REPLY_TIMEOUT_MS = 3000
/**
 * Each probe channel may buffer about this much of its measured send rate (within the bounds
 * below): enough to stay busy between refills on a 100+ Mbps link, while media sharing the
 * connection waits behind it at most about this long. Refills happen when the buffer falls to half.
 */
const PROBE_BUFFER_MS = 40
const PROBE_BUFFER_MIN = REPLAY_BUFFER_MAX
const PROBE_BUFFER_MAX = 1024 * 1024
/** Backstop refill period (worker ticker), should a buffer-low event not come. */
const PROBE_TICK_MS = 50
/** Longest normal gap between refills (the backstop ticks every 50 ms); longer means starved. */
export const PROBE_MAX_GAP_MS = 250
/** Forget a neighbour's probe that never ended after this long. */
const PROBE_RX_STALE_MS = 10_000

/** How a probe ran, as far as its result can be trusted. */
export interface ProbeRun {
  /** Longest time between two refills, from start to end. */
  maxGapMs: number
  /** From start to the end marker. */
  elapsedMs: number
}

/**
 * Why a probe's result can't be trusted, or null. A starved main thread (long gaps between
 * refills, or an end deadline that fired late) sends far less than the uplink could carry, so the
 * result would be an underestimate. A hidden tab alone is no reason: the probe doesn't depend on
 * main-thread timers, and if hiding did slow it down, that shows up as starvation.
 */
export function probeDiscardReason(r: ProbeRun, durationMs = PROBE_DURATION_MS): 'starved' | null {
  if (r.maxGapMs > PROBE_MAX_GAP_MS || r.elapsedMs > durationMs + PROBE_MAX_GAP_MS) return 'starved'
  return null
}

/** A neighbour to probe through. */
export interface ProbeTarget {
  readonly remoteId: string
  readonly isOpen: boolean
  readonly probeLink: ProbeLink
}

/** The narrow slice of PeerSession the probe needs. */
export interface UploadProbeContext {
  /** Every mesh connection (only open ones are probed). */
  targets(): Iterable<ProbeTarget>
  uplink: {
    readonly stats: { readonly sentBytes: number; readonly droppedBackground: number }
    setBackground(link: ProbeLink, on: boolean, bufferMax: number): void
    queued(link: ProbeLink): number
    send(link: ProbeLink, data: Uint8Array, layer: number, maxAgeMs?: number): void
    forget(link: ProbeLink): void
    /** Sends what queued items now fit. */
    kick(): void
  }
  /** setProbe returns whether the estimate changed (a large drop waits for confirmation). */
  capacity: { readonly probeKbps: number | null; setProbe(kbps: number): boolean }
  sendTo(to: string, msg: PeerMsg): void
  /** A probe produced a new estimate. */
  onProbed(): void
}

/** Fisher-Yates shuffle, in place. */
export function shuffle<T>(xs: T[], random: () => number = Math.random): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[xs[i], xs[j]] = [xs[j], xs[i]]
  }
  return xs
}

export class UploadProbe {
  private probing = false
  private peersUsed = 0
  private rx = new Map<string, { firstAt: number; lastAt: number; bytes: number }>()
  private replies = new Map<string, (r: { bytes: number; ms: number }) => void>()
  private _lastProbeAt = -Infinity

  constructor(private ctx: UploadProbeContext) {}

  /** When the last probe started (performance.now()), or -Infinity. */
  get lastProbeAt(): number {
    return this._lastProbeAt
  }

  private openTargets(): ProbeTarget[] {
    return [...this.ctx.targets()].filter((c) => c.isOpen)
  }

  /** Probes once neighbours exist, and again once if the first probe had fewer than three. */
  maybeProbe(): void {
    if (this.probing) return
    const open = this.openTargets()
    if (!open.length) return
    if (this.ctx.capacity.probeKbps !== null && (this.peersUsed >= PROBE_PEERS || open.length <= this.peersUsed)) return
    void this.probe()
  }

  /**
   * Measures this peer's upload: a 1.5 s probe sent in parallel to up to 3 random neighbours,
   * which report bytes received. Their sum, plus whatever the uplink sent meanwhile (relayed or
   * published media share the same pipe), is the estimate. Several receivers mean we measure our
   * own uplink, not one receiver's downlink. Null when there was nobody to probe, or the probe was
   * discarded as untrustworthy (see probeDiscardReason).
   */
  async probe(): Promise<number | null> {
    if (this.probing) return null
    this.probing = true
    this._lastProbeAt = performance.now()
    const { uplink } = this.ctx
    const targets = shuffle(this.openTargets()).slice(0, PROBE_PEERS)
    const cancels: (() => void)[] = []
    try {
      if (!targets.length) return null
      const replies = targets.map(
        (c) =>
          new Promise<{ bytes: number; ms: number }>((resolve) => {
            const cancel = after(PROBE_DURATION_MS + PROBE_REPLY_TIMEOUT_MS, () => resolve({ bytes: 0, ms: 0 }))
            cancels.push(cancel)
            this.replies.set(c.remoteId, (r) => {
              cancel()
              resolve(r)
            })
          }),
      )
      // Probe chunks join the uplink queue at background priority: they fill only the upload that
      // media leaves spare (and go through the debug shaper), so a probe never delays the stream.
      const start = performance.now()
      const sentBefore = uplink.stats.sentBytes
      const droppedBefore = uplink.stats.droppedBackground
      const lanes = targets.map((c) => ({
        link: c.probeLink,
        enqueued: 0,
        bufferMax: PROBE_BUFFER_MIN,
        threshold: c.probeLink.bufferLowThreshold,
      }))
      const probeId = crypto.getRandomValues(new Uint32Array(1))[0]
      const chunk = () => {
        const c = new Uint8Array(PROBE_CHUNK)
        new DataView(c.buffer).setUint32(0, probeId, true)
        return c
      }
      let lastRefill = start
      let maxGapMs = 0
      let ended = false
      // Keeps each channel's buffer topped up. Runs on its buffer-low events and the worker ticker,
      // never a main-thread timer, and records gaps (a starved main thread under-sends).
      const refill = () => {
        if (ended) return
        const now = performance.now()
        maxGapMs = Math.max(maxGapMs, now - lastRefill)
        lastRefill = now
        for (const lane of lanes) {
          const l = lane.link
          // Grow the buffer allowance with the rate the channel has sent at so far.
          const drained = (lane.enqueued - uplink.queued(l)) * PROBE_CHUNK - l.bufferedAmount
          const rate = Math.max(0, drained) / Math.max(1, now - start)
          lane.bufferMax = Math.min(PROBE_BUFFER_MAX, Math.max(lane.bufferMax, rate * PROBE_BUFFER_MS))
          uplink.setBackground(l, true, lane.bufferMax)
          l.bufferLowThreshold = Math.floor(lane.bufferMax / 2)
        }
        // Buffers have room again: what already waits goes first.
        uplink.kick()
        for (const lane of lanes) {
          const l = lane.link
          // The queue holds a buffer's worth on top, so the buffer crosses its low mark again and
          // the next event comes. A send may go straight out (the uplink drains on every send).
          const depth = Math.ceil(lane.bufferMax / PROBE_CHUNK) + 1
          for (let i = 0; i < 2 * depth + 2 && l.isOpen && uplink.queued(l) < depth; i++) {
            uplink.send(l, chunk(), 0, PROBE_DURATION_MS)
            lane.enqueued++
          }
        }
      }
      for (const lane of lanes) lane.link.onBufferLow = refill
      cancels.push(every(PROBE_TICK_MS, refill))
      refill()
      // The deadline is on the worker ticker too, so the probe lasts 1.5 s even when hidden.
      await sleep(PROBE_DURATION_MS)
      refill()
      ended = true
      const end = performance.now()
      // The end marker goes on the reliable control channel, outside the uplink queue: each
      // receiver reports what arrived until then.
      for (const c of targets) this.ctx.sendTo(c.remoteId, { t: 'probe-end', id: probeId })
      // Probe chunks handed to the channels: enqueued, less what still waits or expired.
      let probeItems = droppedBefore - uplink.stats.droppedBackground
      for (const lane of lanes) {
        probeItems += lane.enqueued - uplink.queued(lane.link)
        lane.link.onBufferLow = null
        lane.link.bufferLowThreshold = lane.threshold
        // Whatever is still queued would only go out after the end marker.
        uplink.forget(lane.link)
      }
      // Media sent meanwhile (the uplink's byte count includes the probe chunks: subtract them).
      const mediaBytes = Math.max(0, uplink.stats.sentBytes - sentBefore - probeItems * PROBE_CHUNK)
      const mediaKbps = (mediaBytes * 8) / Math.max(1, end - start)
      const discard = probeDiscardReason({ maxGapMs, elapsedMs: end - start })
      if (discard) {
        console.debug(`upload probe discarded (${discard})`)
        return null
      }
      // Receivers see the probe in bursts at different times: divide the total by the longest window.
      const got = await Promise.all(replies)
      const window = Math.max(...got.map((r) => r.ms))
      const probeKbps = window > 0 ? (got.reduce((a, r) => a + r.bytes, 0) * 8) / window : 0
      const kbps = probeKbps > 0 ? probeKbps + mediaKbps : 0
      if (kbps > 0) {
        this.peersUsed = targets.length
        if (this.ctx.capacity.setProbe(kbps)) this.ctx.onProbed()
      }
      return kbps
    } finally {
      for (const cancel of cancels) cancel()
      for (const c of targets) this.replies.delete(c.remoteId)
      this.probing = false
    }
  }

  /** A neighbour's report of our probe. */
  onResult(from: string, r: { bytes: number; ms: number }): void {
    this.replies.get(from)?.(r)
  }

  /** Receiving side of a neighbour's probe: count bytes per probe id until its end marker. */
  onChunk(data: Uint8Array, from: string): void {
    if (data.byteLength < 4) return
    const key = `${from}:${new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true)}`
    const now = performance.now()
    const st = this.rx.get(key)
    if (!st) {
      // The first chunk only starts the clock.
      this.rx.set(key, { firstAt: now, lastAt: now, bytes: 0 })
      for (const [k, v] of this.rx) if (now - v.lastAt > PROBE_RX_STALE_MS) this.rx.delete(k)
    } else {
      st.bytes += data.byteLength
      st.lastAt = now
    }
  }

  /** A neighbour's probe ended: report what arrived. */
  onEnd(id: number, from: string): void {
    const key = `${from}:${id >>> 0}`
    const st = this.rx.get(key)
    this.rx.delete(key)
    this.ctx.sendTo(from, { t: 'probe-result', bytes: st?.bytes ?? 0, ms: st ? st.lastAt - st.firstAt : 0 })
  }
}
