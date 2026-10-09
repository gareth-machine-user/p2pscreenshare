// Headroom discovery, the only probing: while no media connection is backlogged, the session
// pushes low-priority bytes onto every open connection for 1.5 s (each connection's `bin` channel,
// through the uplink's background slot, so live media always goes first) and measures what each
// delivered, as for any other window (session/capacity.ts). Those windows count as backlogged.
// Nobody receives or reports anything: the receiver drops the bytes.
//
// A presenter's tab is usually hidden while it shares another window, and hidden tabs' timers are
// throttled. So refills are driven by the channels' buffer-low events (with the worker ticker as a
// backstop) and the probe ends on the worker ticker: neither is throttled. A probe whose refills
// were starved anyway (a frozen page) is discarded rather than taken as a (far too low) measurement.
import { BACKGROUND_BUFFER_MAX, type ProbeLink } from '../net/link'
import { every, sleep } from '../net/ticker'

export const PROBE_DURATION_MS = 1500
export const PROBE_CHUNK = 16 * 1024
/**
 * Each channel's send-buffer allowance (the uplink's bound for background data; refills happen
 * when it falls to half, the `bin` channel's low mark). Small on purpose: the `bin` channel shares
 * its SCTP association with the connection's media (and the mesh link's `ctl`), and in Chromium a
 * deep buffer there can stall the whole association for seconds.
 */
export const PROBE_BUFFER = BACKGROUND_BUFFER_MAX
/** Backstop refill period (worker ticker), should a buffer-low event not come. */
const PROBE_TICK_MS = 50
/** Longest normal gap between refills; longer means the page was starved (ms). */
export const PROBE_MAX_GAP_MS = 250

/** Headroom discovery runs this often while no media connection is backlogged... */
export const HEADROOM_EVERY_MS = 30_000
/** ...or this often while the measured capacity holds the bitrate below the chosen quality... */
export const HEADROOM_LIMITED_MS = 5000
/** ...and the encoder uses at least this share of that bitrate (the limit binds)... */
export const LIMIT_BINDS_SHARE = 0.7
/** ...and first this long after the first link opens. */
export const HEADROOM_FIRST_MS = 1000

/**
 * Whether headroom discovery is due. The fast cadence is for a presenter whose bitrate a capacity
 * estimate holds down while the stream would use more: only a probe raises a stale or low estimate.
 * A stream far below its bitrate (a static screen) loses nothing to the limit, and every probe
 * fills each connection's SCTP association for 1.5 s, the media and ctl channels' too.
 */
export function discoveryDue(o: {
  now: number
  firstLinkAt: number
  /** When the last probe started, or -Infinity. */
  lastAt: number
  /** A capacity estimate holds the bitrate below the chosen quality. */
  limited: boolean
  /** What the encoder put out over the last window, and its bitrate (kbps), if presenting. */
  encoderKbps: number | null
  targetKbps: number | null
}): boolean {
  if (o.lastAt === -Infinity) return o.now - o.firstLinkAt >= HEADROOM_FIRST_MS
  const binds = o.limited && o.encoderKbps !== null && o.targetKbps !== null && o.encoderKbps >= LIMIT_BINDS_SHARE * o.targetKbps
  return o.now - o.lastAt >= (binds ? HEADROOM_LIMITED_MS : HEADROOM_EVERY_MS)
}

/** Whether a probe's sending was starved (long gaps between refills, or a late end). */
export function probeStarved(r: { maxGapMs: number; elapsedMs: number }, durationMs = PROBE_DURATION_MS): boolean {
  return r.maxGapMs > PROBE_MAX_GAP_MS || r.elapsedMs > durationMs + PROBE_MAX_GAP_MS
}

/** The slice of the uplink a probe drives. */
export interface ProbeUplink {
  setBackground(link: ProbeLink, on: boolean): void
  queued(link: ProbeLink): number
  send(link: ProbeLink, data: Uint8Array, layer: number, maxAgeMs?: number): void
  /** Drops what still waits for a link. */
  discard(link: ProbeLink): void
  /** Sends what queued items now fit. */
  kick(): void
}

export class HeadroomProbe {
  running = false
  /** When the last probe started (performance.now()), or -Infinity. */
  lastAt = -Infinity
  private chunk = new Uint8Array(PROBE_CHUNK)

  constructor(private uplink: ProbeUplink) {}

  /**
   * Keeps every link's channel busy for PROBE_DURATION_MS. `snapshot` is taken right before the
   * first byte and right after the last: the caller measures what was delivered in between. Null
   * if a probe is already running, there is nothing to probe, or the probe was starved.
   */
  async run<S>(links: ProbeLink[], snapshot: () => S): Promise<{ start: S; end: S } | null> {
    if (this.running || !links.length) return null
    this.running = true
    this.lastAt = performance.now()
    const { uplink } = this
    let cancel = () => {}
    try {
      const depth = Math.ceil(PROBE_BUFFER / PROBE_CHUNK) + 1
      let lastRefill = performance.now()
      let maxGapMs = 0
      let ended = false
      // Keeps each channel topped up: the queue holds a buffer's worth on top, so the buffer
      // crosses its low mark again and the next event comes.
      const refill = () => {
        if (ended) return
        const now = performance.now()
        maxGapMs = Math.max(maxGapMs, now - lastRefill)
        lastRefill = now
        uplink.kick()
        for (const l of links) for (let i = 0; i < 2 * depth && l.isOpen && uplink.queued(l) < depth; i++) uplink.send(l, this.chunk, 0, PROBE_DURATION_MS)
      }
      for (const l of links) {
        uplink.setBackground(l, true)
        l.onBufferLow = refill
      }
      const start = snapshot()
      const t0 = performance.now()
      cancel = every(PROBE_TICK_MS, refill)
      refill()
      await sleep(PROBE_DURATION_MS)
      refill()
      ended = true
      const end = snapshot()
      if (probeStarved({ maxGapMs, elapsedMs: performance.now() - t0 })) {
        console.debug('headroom probe discarded (starved)')
        return null
      }
      return { start, end }
    } finally {
      cancel()
      for (const link of links) {
        link.onBufferLow = null
        uplink.discard(link)
        uplink.setBackground(link, false)
      }
      this.running = false
    }
  }
}
