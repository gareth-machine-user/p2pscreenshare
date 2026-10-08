import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_HIGH, LINK_BUFFER_LOW, type MediaLink } from './link'
import { tuning } from '../tuning'

// Per-layer queueing deadlines (see tuning.ts): when the uplink can't keep up, enhancement layers
// (T2, then T1) expire first, so overloaded relays degrade frame rate instead of stalling the
// base layer.
const MAX_AGE_MS_BY_LAYER = tuning.maxAgeByLayer

/**
 * A connection whose send buffer holds more than LINK_BUFFER_LOW and hasn't drained a byte for this
 * long is stalled (ms). A path at any rate drains something every round trip; what stops a whole
 * SCTP association instead is loss recovery by retransmission timeout (Chromium's minimum is
 * ~400 ms, doubling on each repeat), e.g. after a burst overflowed the connection's 64 KB UDP
 * socket buffer. A stall is that connection's alone: its windows say nothing about capacity.
 */
export const STALL_MS = 750

/** How long a frame that lost a fragment on a link is remembered, so its other fragments are dropped too (ms). */
const DEAD_FRAME_RETAIN_MS = 2000
/** The upload cap's token bucket holds this much sending time as burst (ms). */
const CAP_BURST_MS = 40
/** While the cap's tokens are spent, drain again after this long (ms). */
const TOKEN_RETRY_MS = 4

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

/** Counters for one link (cumulative). Live media only, except where noted. */
export interface LinkCounters {
  /** Every byte handed to the channel: live media, replays and background (probe) data. */
  handedBytes: number
  /**
   * How long the link's queue has held something, up to `busySince` (ms). A link whose queue never
   * empties over a window carried all it could: it was backlogged (session/capacity.ts).
   */
  busyMs: number
  /** Since when the queue has been non-empty, or null while it is empty. */
  busySince: number | null
  sentItems: number
  /** Live-media bytes handed to the channel (with bufferedAmount, how long its buffer takes to drain). */
  sentBytes: number
  drops: number
  queueDelaySum: number
  queueDelayN: number
  /** When the link was last seen stalled (STALL_MS without draining), or -Infinity. */
  lastStallAt: number
}

/**
 * One connection's counters at one moment: its media channel and its bin channel (headroom probes)
 * together. Two of them make a capacity window (session/capacity.ts linkWindow).
 */
export interface LinkSnap {
  at: number
  /** Bytes handed to the connection's channels (LinkCounters.handedBytes). */
  handed: number
  /** Their bufferedAmount. */
  buffered: number
  /** How long the media link's uplink queue has held something (Uplink.busyMs). */
  busyMs: number
  /** Live media items and bytes sent, drops, queueing sum and count. */
  items: number
  mediaBytes: number
  drops: number
  qSum: number
  qN: number
  /** When the connection was last seen stalled (STALL_MS), or -Infinity. */
  lastStallAt: number
  /** How long the oldest item waiting for it has waited (ms). */
  headAgeMs: number
}

/** Everything the uplink keeps for one link. */
interface LinkEntry {
  queue: Item[]
  /** Only spare upload (a headroom probe's `bin` channel): see setBackground. */
  background: boolean
  /** Frames that already lost a fragment here (until when to remember them). */
  dead: Map<string, number>
  counters: LinkCounters
  /** Its send buffer as last seen (plus what was sent into it since), and when it last drained. */
  progress: { buffered: number; at: number } | null
}

export interface UplinkStats {
  sentBytes: number
  droppedItems: number
  sentItems: number
  queuedBytes: number
  /** Media items dropped for missing their queueing deadline, by temporal layer (T0..T3). */
  droppedByLayer: number[]
  /** Background (headroom probe) items dropped. */
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
  /** Every link the uplink has seen, until it closes (session/capacity.ts reads their counters). */
  private links = new Map<MediaLink, LinkEntry>()
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

  private entry(link: MediaLink): LinkEntry {
    let e = this.links.get(link)
    if (!e) {
      e = {
        queue: [],
        background: false,
        dead: new Map(),
        counters: { handedBytes: 0, busyMs: 0, busySince: null, sentItems: 0, sentBytes: 0, drops: 0, queueDelaySum: 0, queueDelayN: 0, lastStallAt: -Infinity },
        progress: null,
      }
      this.links.set(link, e)
    }
    return e
  }

  /** A link's cumulative counters, if the uplink has seen it. */
  countersOf(link: MediaLink): Readonly<LinkCounters> | undefined {
    return this.links.get(link)?.counters
  }

  /**
   * How long (ms) `link`'s send buffer has held more than LINK_BUFFER_LOW without draining; 0 while
   * it drains or is nearly empty. Every call is an observation: callers that pick links (the
   * relay, on every fragment) keep it current. At STALL_MS or more the link is stalled.
   */
  stalledMs(link: MediaLink, now = performance.now()): number {
    const b = link.isOpen ? link.bufferedAmount : 0
    const e = this.entry(link)
    const p = e.progress
    if (!p) {
      e.progress = { buffered: b, at: now }
      return 0
    }
    if (b <= LINK_BUFFER_LOW || b < p.buffered) p.at = now
    p.buffered = b
    const ms = now - p.at
    if (ms >= STALL_MS) e.counters.lastStallAt = now
    return ms
  }

  /** Whether `link` is stalled (see stalledMs). */
  isStalled(link: MediaLink, now = performance.now()): boolean {
    return this.stalledMs(link, now) >= STALL_MS
  }

  /** How long `link`'s queue has held something in total (ms), up to `now`. */
  busyMs(link: MediaLink, now = performance.now()): number {
    const c = this.links.get(link)?.counters
    if (!c) return 0
    return c.busyMs + (c.busySince !== null ? now - c.busySince : 0)
  }

  /** How long the oldest item waiting for `link` has waited (ms); 0 when nothing waits. */
  headAgeMs(link: MediaLink, now = performance.now()): number {
    const q = this.links.get(link)?.queue
    if (!q?.length) return 0
    let oldest = q[0].enqueuedAt
    for (const it of q) if (it.enqueuedAt < oldest) oldest = it.enqueuedAt
    return now - oldest
  }

  /**
   * One connection's counters now (see LinkSnap): its media link and its probe link together. Also
   * an observation of whether the media link is stalled (stalledMs).
   */
  snapshot(media: MediaLink, probe: MediaLink, now = performance.now()): LinkSnap {
    this.stalledMs(media, now)
    const c = this.links.get(media)?.counters
    const b = this.links.get(probe)?.counters
    return {
      at: now,
      handed: (c?.handedBytes ?? 0) + (b?.handedBytes ?? 0),
      buffered: (media.isOpen ? media.bufferedAmount : 0) + (probe.isOpen ? probe.bufferedAmount : 0),
      busyMs: this.busyMs(media, now),
      items: c?.sentItems ?? 0,
      mediaBytes: c?.sentBytes ?? 0,
      drops: c?.drops ?? 0,
      qSum: c?.queueDelaySum ?? 0,
      qN: c?.queueDelayN ?? 0,
      lastStallAt: c?.lastStallAt ?? -Infinity,
      headAgeMs: this.headAgeMs(media, now),
    }
  }

  /** Keeps the link's busy clock in step with whether its queue holds anything. */
  private markBusy(c: LinkCounters, busy: boolean, now: number): void {
    if (busy && c.busySince === null) c.busySince = now
    else if (!busy && c.busySince !== null) {
      c.busyMs += now - c.busySince
      c.busySince = null
    }
  }

  /**
   * Marks a link as background (a headroom probe's `bin` channel): its traffic only uses spare
   * upload, served when no media is waiting and only while its send buffer holds at most
   * BACKGROUND_BUFFER_MAX.
   */
  setBackground(link: MediaLink, on = true): void {
    this.entry(link).background = on
  }

  /**
   * Queues one message for a link. Replayed (GOP cache) fragments wait behind live ones: a new
   * child's live frames then arrive on time and its jitter buffer isn't inflated by the backlog.
   */
  send(link: MediaLink, data: Uint8Array, layer: number, maxAgeMs?: number, replay = false, frame?: string): void {
    const e = this.entry(link)
    // The rest of a frame that already lost a fragment on this link would only waste upload.
    if (frame && e.dead.has(frame)) {
      this.stats.droppedItems++
      this.stats.droppedByLayer[Math.min(3, layer)]++
      if (!replay) e.counters.drops++
      return
    }
    const q = e.queue
    const item: Item = { data, layer, replay, frame, enqueuedAt: performance.now(), maxAge: maxAgeMs ?? maxAgeForLayer(layer) }
    const firstReplay = replay ? -1 : q.findIndex((it) => it.replay)
    if (firstReplay >= 0) q.splice(firstReplay, 0, item)
    else q.push(item)
    this.stats.queuedBytes += data.byteLength
    this.markBusy(e.counters, true, item.enqueuedAt)
    this.drain()
  }

  /**
   * Moves what waits for `from` (live media and replays, not background) to `to`, merged by queueing
   * time: `from` stalled, and its stripes now go over `to`.
   */
  moveQueued(from: MediaLink, to: MediaLink): void {
    const src = this.links.get(from)
    if (!src?.queue.length || from === to || src.background) return
    const dst = this.entry(to)
    if (dst.background) return
    // Live before replays, each in queueing order (as send() keeps them).
    const merged = [...dst.queue, ...src.queue].sort((a, b) => Number(a.replay) - Number(b.replay) || a.enqueuedAt - b.enqueuedAt)
    dst.queue = merged
    src.queue = []
    const now = performance.now()
    this.markBusy(src.counters, false, now)
    this.markBusy(dst.counters, true, now)
    this.drain()
  }

  /** Items waiting for one link. */
  queued(link: MediaLink): number {
    return this.links.get(link)?.queue.length ?? 0
  }

  /** Drops everything waiting for `link` (a probe that ended), keeping its counters. */
  discard(link: MediaLink): void {
    const e = this.links.get(link)
    if (!e) return
    for (const it of e.queue) this.drop(it, e.background)
    e.queue = []
    this.markBusy(e.counters, false, performance.now())
  }

  /** Forgets a link (it closed): what waits for it, and its counters. */
  forget(link: MediaLink): void {
    const e = this.links.get(link)
    if (e) for (const it of e.queue) this.stats.queuedBytes -= it.data.byteLength
    this.links.delete(link)
  }

  /** Called when a link's send buffer drains. */
  kick(): void {
    this.drain()
  }

  private refill(now: number): void {
    if (this.capKbps === null) return
    const burst = this.rate * CAP_BURST_MS
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
      for (const [link, e] of this.links) {
        const q = e.queue
        if (!q.length) continue
        const { background: bg, dead } = e
        for (const [f, until] of dead) if (now > until) dead.delete(f)
        for (const it of q) if (it.frame && now - it.enqueuedAt > it.maxAge) dead.set(it.frame, now + DEAD_FRAME_RETAIN_MS)
        let kept = 0
        for (const it of q) {
          if (now - it.enqueuedAt > it.maxAge || (it.frame && dead.has(it.frame))) {
            this.drop(it, bg)
            if (!bg && !it.replay) e.counters.drops++
          } else q[kept++] = it
        }
        q.length = kept
        if (kept && link.isOpen && link.bufferedAmount > LINK_BUFFER_HIGH) {
          this.stats.bufferStalls++
          if (!bg) this.stalledMs(link, now)
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
        const mediaWaiting = [...this.links].some(
          ([l, e]) => e.queue.length > 0 && !e.background && l.isOpen && l.bufferedAmount <= LINK_BUFFER_HIGH,
        )
        const links = [...this.links].filter(([, e]) => !mediaWaiting || !e.background)
        const n = links.length
        // Fixed for the pass (the cursor moves as links are served; reading it here would skip some).
        const start = this.cursor
        for (let i = 0; i < n; i++) {
          const idx = (start + i) % n
          const [link, e] = links[idx]
          const q = e.queue
          if (!link.isOpen) {
            if (link.state === 'closed' || link.state === 'failed') this.forget(link)
            continue
          }
          // Background links (probes) are bounded below, by BACKGROUND_BUFFER_MAX.
          if (!q.length || (!e.background && link.bufferedAmount > LINK_BUFFER_HIGH)) continue
          const it = q[0]
          // Catch-up replays and probes only go out while the channel's send buffer is nearly
          // empty: a mesh link's channels share one connection, so a deep backlog of either would
          // hold up live media (audio especially) inside it.
          if ((it.replay || e.background) && link.bufferedAmount > BACKGROUND_BUFFER_MAX) continue
          // Tokens may go negative (debt), so messages larger than the burst still get through.
          if (this.capKbps !== null && this.tokens <= 0) {
            waitingOnTokens = true
            break
          }
          q.shift()
          this.stats.queuedBytes -= it.data.byteLength
          if (link.send(it.data)) {
            // What went into the buffer isn't drained by the next look at it.
            if (e.progress) e.progress.buffered += it.data.byteLength
            const c = e.counters
            c.handedBytes += it.data.byteLength
            this.tokens -= it.data.byteLength
            this.stats.sentBytes += it.data.byteLength
            this.stats.sentItems++
            // Live media only: replays to a new child are meant to wait behind it.
            if (!e.background && !it.replay) {
              this.stats.queueDelaySum += now - it.enqueuedAt
              this.stats.queueDelayN++
              c.sentItems++
              c.sentBytes += it.data.byteLength
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
      for (const e of this.links.values()) if (!e.queue.length) this.markBusy(e.counters, false, now)
      if (waitingOnTokens && this.timer === null) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.drain()
        }, TOKEN_RETRY_MS)
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
}
