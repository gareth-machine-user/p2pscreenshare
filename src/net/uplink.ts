import { LINK_BUFFER_HIGH, type MediaLink } from './link'
import { tuning } from '../tuning'

// Per-layer queueing deadlines (see tuning.ts): when the uplink can't keep up, enhancement layers
// (T2, then T1) expire first, so overloaded relays degrade frame rate instead of stalling the
// base layer.
const MAX_AGE_MS_BY_LAYER = tuning.maxAgeByLayer

/** Layers beyond the table (none on the wire: the layer is 2 bits) get the last entry's deadline. */
function maxAgeForLayer(layer: number): number {
  return MAX_AGE_MS_BY_LAYER[Math.min(layer, MAX_AGE_MS_BY_LAYER.length - 1)]
}

interface Item {
  data: Uint8Array
  layer: number
  /** GOP-cache replay for a newly attached child: queued behind live fragments. */
  replay: boolean
  /** Which frame this fragment belongs to: once one fragment of a frame is dropped, the rest are useless. */
  frame?: string
  enqueuedAt: number
  maxAge: number
}

/** Live-media counters for one link (cumulative). */
export interface LinkCounters {
  sentItems: number
  drops: number
  queueDelaySum: number
  queueDelayN: number
  stalls: number
}

export interface UplinkStats {
  sentBytes: number
  droppedItems: number
  sentItems: number
  queuedBytes: number
  /** Media items dropped for missing their queueing deadline, by temporal layer (T0..T3). */
  droppedByLayer: number[]
  /** Background (probe) items dropped. */
  droppedBackground: number
  /** GOP-cache replay items dropped (a new child's catch-up, not live media: not a congestion signal). */
  droppedReplay: number
  /** Items the data channel refused (link closing). */
  sendFailed: number
  /** Drains that found a link's send buffer full while it had items waiting. */
  bufferStalls: number
  /** Sum and count of time spent queued by sent media items (ms), for an average. */
  queueDelaySum: number
  queueDelayN: number
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
  stats: UplinkStats = {
    sentBytes: 0,
    droppedItems: 0,
    sentItems: 0,
    queuedBytes: 0,
    droppedByLayer: [0, 0, 0, 0],
    droppedBackground: 0,
    droppedReplay: 0,
    sendFailed: 0,
    bufferStalls: 0,
    queueDelaySum: 0,
    queueDelayN: 0,
  }

  constructor(public capKbps: number | null = null) {}

  /** Bytes per ms allowed by the cap. */
  private get rate(): number {
    // kbps / 8 = bytes per ms
    return this.capKbps === null ? Infinity : this.capKbps / 8
  }

  /** Links whose traffic only uses spare upload (e.g. probes): served when no media is waiting. */
  private background = new Set<MediaLink>()
  /** Per link: frames that already lost a fragment there (until when to remember them). */
  private deadFrames = new Map<MediaLink, Map<string, number>>()
  /**
   * Per-link live-media counters: a full uplink congests most links at once, while one slow
   * receiver (its downlink or path) congests only its own link.
   */
  readonly perLink = new Map<MediaLink, LinkCounters>()

  private counters(link: MediaLink): LinkCounters {
    let c = this.perLink.get(link)
    if (!c) {
      c = { sentItems: 0, drops: 0, queueDelaySum: 0, queueDelayN: 0, stalls: 0 }
      this.perLink.set(link, c)
    }
    return c
  }

  setBackground(link: MediaLink, on = true): void {
    if (on) this.background.add(link)
    else this.background.delete(link)
  }

  /**
   * Queues one message for a link. Replayed (GOP cache) fragments wait behind live ones: a new
   * child's live frames then arrive on time and its jitter buffer isn't inflated by the backlog.
   */
  send(link: MediaLink, data: Uint8Array, layer: number, maxAgeMs?: number, replay = false, frame?: string): void {
    // The rest of a frame that already lost a fragment on this link would only waste upload.
    if (frame && this.deadFrames.get(link)?.has(frame)) {
      this.stats.droppedItems++
      this.stats.droppedByLayer[Math.min(3, layer)]++
      if (!replay) this.counters(link).drops++
      return
    }
    let q = this.queues.get(link)
    if (!q) {
      q = []
      this.queues.set(link, q)
    }
    const item: Item = { data, layer, replay, frame, enqueuedAt: performance.now(), maxAge: maxAgeMs ?? maxAgeForLayer(layer) }
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
    this.deadFrames.delete(link)
    this.perLink.delete(link)
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
      // Expired items go once per drain (not once per pass: that made a congested drain quadratic).
      // A frame that loses one fragment loses all of them on that link (frame-aware dropping).
      for (const [link, q] of this.queues) {
        if (!q.length) continue
        const bg = this.background.has(link)
        let dead = this.deadFrames.get(link)
        if (dead) for (const [f, until] of dead) if (now > until) dead.delete(f)
        for (const it of q) {
          if (it.frame && now - it.enqueuedAt > it.maxAge) {
            if (!dead) this.deadFrames.set(link, (dead = new Map()))
            dead.set(it.frame, now + 2000)
          }
        }
        let kept = 0
        for (const it of q) {
          if (now - it.enqueuedAt > it.maxAge || (it.frame && dead?.has(it.frame))) {
            this.drop(it, bg)
            if (!bg && !it.replay) this.counters(link).drops++
          } else q[kept++] = it
        }
        q.length = kept
        if (kept && link.isOpen && link.bufferedAmount > LINK_BUFFER_HIGH) {
          this.stats.bufferStalls++
          if (!bg) this.counters(link).stalls++
        }
      }
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
        // Fixed for the pass (the cursor moves as links are served; reading it here would skip some).
        const start = this.cursor
        for (let i = 0; i < n; i++) {
          const idx = (start + i) % n
          const link = links[idx]
          const q = this.queues.get(link)!
          if (!link.isOpen) {
            if (link.state === 'closed' || link.state === 'failed') this.forget(link)
            continue
          }
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
            // Live media only: replays to a new child are meant to wait behind it.
            if (!this.background.has(link) && !it.replay) {
              this.stats.queueDelaySum += now - it.enqueuedAt
              this.stats.queueDelayN++
              const c = this.counters(link)
              c.sentItems++
              c.queueDelaySum += now - it.enqueuedAt
              c.queueDelayN++
            }
          } else {
            this.stats.droppedItems++
            this.stats.sendFailed++
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

  private drop(it: Item, background = false): void {
    this.stats.queuedBytes -= it.data.byteLength
    this.stats.droppedItems++
    if (background) this.stats.droppedBackground++
    else if (it.replay) this.stats.droppedReplay++
    else this.stats.droppedByLayer[Math.min(3, it.layer)]++
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
