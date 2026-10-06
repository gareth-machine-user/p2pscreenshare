// The upload probe: measures this peer's upload by sending to a few neighbours in parallel, and
// answers neighbours' probes (bytes received over the arrival window).
import type { MediaLink } from '../net/link'
import type { PeerMsg } from '../proto/messages'

const PROBE_DURATION_MS = 1500
const PROBE_CHUNK = 16 * 1024
const PROBE_PEERS = 3
const PROBE_REPLY_TIMEOUT_MS = 3000
/** Chunks queued per neighbour at once, and per pacing tick. */
const PROBE_QUEUE_DEPTH = 4
const PROBE_PACE_MS = 4
/** Forget a neighbour's probe that never ended after this long. */
const PROBE_RX_STALE_MS = 10_000

/** A neighbour to probe through. */
export interface ProbeTarget {
  readonly remoteId: string
  readonly isOpen: boolean
  readonly probeLink: MediaLink
}

/** The narrow slice of PeerSession the probe needs. */
export interface UploadProbeContext {
  /** Every mesh connection (only open ones are probed). */
  targets(): Iterable<ProbeTarget>
  uplink: {
    readonly stats: { readonly sentBytes: number }
    setBackground(link: MediaLink): void
    queued(link: MediaLink): number
    send(link: MediaLink, data: Uint8Array, layer: number, maxAgeMs?: number): void
  }
  capacity: { readonly probeKbps: number | null; setProbe(kbps: number): void }
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
   * Measures this peer's upload: a paced 1.5 s probe sent in parallel to up to 3 random
   * neighbours, which report bytes received. Their sum, plus whatever the uplink sent meanwhile
   * (relayed or published media share the same pipe), is the estimate. Several receivers mean we
   * measure our own uplink, not one receiver's downlink.
   */
  async probe(): Promise<number | null> {
    if (this.probing) return null
    this.probing = true
    this._lastProbeAt = performance.now()
    const { uplink } = this.ctx
    try {
      const targets = shuffle(this.openTargets()).slice(0, PROBE_PEERS)
      if (!targets.length) return null
      const replies = targets.map(
        (c) =>
          new Promise<{ bytes: number; ms: number }>((resolve) => {
            const t = setTimeout(() => resolve({ bytes: 0, ms: 0 }), PROBE_DURATION_MS + PROBE_REPLY_TIMEOUT_MS)
            this.replies.set(c.remoteId, (r) => {
              clearTimeout(t)
              resolve(r)
            })
          }),
      )
      // Probe chunks join the uplink queue at background priority: they fill only the upload that
      // media leaves spare (and go through the debug shaper), so a probe never delays the stream.
      const start = performance.now()
      const sentBefore = uplink.stats.sentBytes
      const links = targets.map((c) => c.probeLink)
      for (const l of links) uplink.setBackground(l)
      const probeId = crypto.getRandomValues(new Uint32Array(1))[0]
      const chunk = () => {
        const c = new Uint8Array(PROBE_CHUNK)
        new DataView(c.buffer).setUint32(0, probeId, true)
        return c
      }
      let probeBytes = 0
      while (performance.now() - start < PROBE_DURATION_MS) {
        for (const l of links) {
          for (let i = 0; i < PROBE_QUEUE_DEPTH && l.isOpen && uplink.queued(l) < PROBE_QUEUE_DEPTH; i++) {
            uplink.send(l, chunk(), 0, PROBE_DURATION_MS)
            probeBytes += PROBE_CHUNK
          }
        }
        await new Promise((r) => setTimeout(r, PROBE_PACE_MS))
      }
      // The end marker goes on the reliable control channel, outside the (possibly long) uplink
      // queue: each receiver reports what arrived until then.
      for (const c of targets) this.ctx.sendTo(c.remoteId, { t: 'probe-end', id: probeId })
      // Media sent meanwhile (the uplink's byte count includes the probe chunks: subtract them).
      const mediaBytes = Math.max(0, uplink.stats.sentBytes - sentBefore - probeBytes)
      const mediaKbps = (mediaBytes * 8) / Math.max(1, performance.now() - start)
      // Receivers see the probe in bursts at different times: divide the total by the longest window.
      const got = await Promise.all(replies)
      const window = Math.max(...got.map((r) => r.ms))
      const probeKbps = window > 0 ? (got.reduce((a, r) => a + r.bytes, 0) * 8) / window : 0
      const kbps = probeKbps > 0 ? probeKbps + mediaKbps : 0
      for (const c of targets) this.replies.delete(c.remoteId)
      if (kbps > 0) {
        this.ctx.capacity.setProbe(kbps)
        this.peersUsed = targets.length
        this.ctx.onProbed()
      }
      return kbps
    } finally {
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
