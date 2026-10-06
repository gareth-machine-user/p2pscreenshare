import { LINK_BUFFER_HIGH, type MediaLink } from './link'

// Per-layer queueing deadlines: when the uplink can't keep up, enhancement layers (T2, then T1)
// expire first, so overloaded relays degrade frame rate instead of stalling the base layer.
const MAX_AGE_MS_BY_LAYER = [900, 350, 180, 180]

interface Item {
  data: Uint8Array
  layer: number
  /** GOP-cache replay for a newly attached child: queued behind live fragments. */
  replay: boolean
  enqueuedAt: number
  maxAge: number
}

export interface UplinkStats {
  sentBytes: number
  droppedItems: number
  sentItems: number
  queuedBytes: number
}

/**
 * The single outgoing pipe of a peer, shared by all child links. Enforces an optional upload cap
 * (token bucket, for simulating constrained peers on one machine), per-link send-buffer
 * backpressure, and layer-aware deadline dropping.
 */
export class Uplink {
  private queues = new Map<MediaLink, Item[]>()
  private tokens = 0
  private lastRefill = performance.now()
  private timer: ReturnType<typeof setTimeout> | null = null
  private draining = false
  /** Where the next drain pass starts (round-robin across drains). */
  private cursor = 0
  stats: UplinkStats = { sentBytes: 0, droppedItems: 0, sentItems: 0, queuedBytes: 0 }

  constructor(public capKbps: number | null = null) {}

  /** Bytes per ms allowed by the cap. */
  private get rate(): number {
    return this.capKbps === null ? Infinity : (this.capKbps * 1000) / 8 / 1000
  }

  /** Links whose traffic only uses spare upload (e.g. probes): served when no media is waiting. */
  private background = new Set<MediaLink>()

  setBackground(link: MediaLink, on = true): void {
    if (on) this.background.add(link)
    else this.background.delete(link)
  }

  /**
   * Queues one message for a link. Replayed (GOP cache) fragments wait behind live ones: a new
   * child's live frames then arrive on time and its jitter buffer isn't inflated by the backlog.
   */
  send(link: MediaLink, data: Uint8Array, layer: number, maxAgeMs?: number, replay = false): void {
    let q = this.queues.get(link)
    if (!q) {
      q = []
      this.queues.set(link, q)
    }
    const item = { data, layer, replay, enqueuedAt: performance.now(), maxAge: maxAgeMs ?? MAX_AGE_MS_BY_LAYER[layer] ?? 900 }
    const firstReplay = replay ? -1 : q.findIndex((it) => it.replay)
    if (firstReplay >= 0) q.splice(firstReplay, 0, item)
    else q.push(item)
    this.stats.queuedBytes += data.byteLength
    this.drain()
  }

  /** Items waiting for one link. */
  queued(link: MediaLink): number {
    return this.queues.get(link)?.length ?? 0
  }

  forget(link: MediaLink): void {
    const q = this.queues.get(link)
    if (q) for (const it of q) this.stats.queuedBytes -= it.data.byteLength
    this.queues.delete(link)
    this.background.delete(link)
  }

  /** Called when a link's send buffer drains. */
  kick(): void {
    this.drain()
  }

  private refill(now: number): void {
    if (this.capKbps === null) return
    const burst = this.rate * 40 // 40ms of burst
    this.tokens = Math.min(burst, this.tokens + (now - this.lastRefill) * this.rate)
    this.lastRefill = now
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      const now = performance.now()
      this.refill(now)
      let progress = true
      let waitingOnTokens = false
      // Round-robin one item per link per pass so children share the uplink fairly. Each drain
      // resumes after the last link served: when tokens are scarce, a fixed starting point would
      // let the first links take everything.
      while (progress) {
        progress = false
        // Background links only get a turn when no media link has anything it could send.
        const mediaWaiting = [...this.queues].some(
          ([l, q]) => q.length > 0 && !this.background.has(l) && l.isOpen && l.bufferedAmount <= LINK_BUFFER_HIGH,
        )
        const links = [...this.queues.keys()].filter((l) => !mediaWaiting || !this.background.has(l))
        const n = links.length
        for (let i = 0; i < n; i++) {
          const idx = (this.cursor + i) % n
          const link = links[idx]
          const q = this.queues.get(link)!
          if (!link.isOpen) {
            if (link.state === 'closed' || link.state === 'failed') this.forget(link)
            continue
          }
          for (let j = q.length - 1; j >= 0; j--) if (now - q[j].enqueuedAt > q[j].maxAge) this.drop(q.splice(j, 1)[0])
          if (!q.length || link.bufferedAmount > LINK_BUFFER_HIGH) continue
          const it = q[0]
          // Tokens may go negative (debt), so messages larger than the burst still get through.
          if (this.capKbps !== null && this.tokens <= 0) {
            waitingOnTokens = true
            break
          }
          q.shift()
          this.stats.queuedBytes -= it.data.byteLength
          if (link.send(it.data)) {
            this.tokens -= it.data.byteLength
            this.stats.sentBytes += it.data.byteLength
            this.stats.sentItems++
          } else {
            this.stats.droppedItems++
          }
          this.cursor = idx + 1
          progress = true
        }
        if (waitingOnTokens) break
      }
      if (waitingOnTokens && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.drain()
        }, 4)
      }
    } finally {
      this.draining = false
    }
  }

  private drop(it: Item): void {
    this.stats.queuedBytes -= it.data.byteLength
    this.stats.droppedItems++
  }

  /** Paces an arbitrary payload through the token bucket (used for the upload probe). */
  async paced(bytes: number): Promise<void> {
    if (this.capKbps === null) return
    for (;;) {
      const now = performance.now()
      this.refill(now)
      if (this.tokens > 0) {
        this.tokens -= bytes
        return
      }
      await new Promise((r) => setTimeout(r, 4))
    }
  }
}
