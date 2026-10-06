// Per-connection stats from RTCPeerConnection.getStats(), and a path RTT history per connection.
// Pure (no browser APIs), for unit tests with fixture reports.
//
// The round-trip time is the selected ICE candidate pair's: the STUN checks a connected pair keeps
// sending (Chrome: one every ~2.6 s). They share the connection's UDP socket, so they wait in any
// queue on the path (a full home router), but not behind the SCTP association's own send backlog
// (the data channels' bufferedAmount), which is what makes them a network-queueing signal. The
// app's ctl-channel pings ride inside SCTP and do queue behind that backlog.
//
// What real browsers expose (measured in e2e/linkstats.spec.ts, Chromium 150): candidate-pair
// currentRoundTripTime / totalRoundTripTime / responsesReceived / bytesSent / bytesReceived, and
// the transport's selectedCandidatePairId. No `sctp-transport` report (so no congestion window),
// and no availableOutgoingBitrate on a data-only connection. Both are parsed in case a browser adds
// them. Firefox has no selectedCandidatePairId: it flags the pair `selected`.

/** One stats object (RTCStats and its subtypes) as plain data. */
export interface StatsRecord {
  id: string
  type: string
  [k: string]: unknown
}

/** An RTCStatsReport, a Map of records, or a plain array of them. */
export type StatsLike = { forEach(cb: (r: StatsRecord) => void): void }

/** RTCSctpTransportStats, when the browser has them. */
export interface SctpStats {
  /** Bytes. */
  congestionWindow: number | null
  receiverWindow: number | null
  smoothedRttMs: number | null
  unackData: number | null
  mtu: number | null
}

/** The interesting parts of one getStats() report. */
export interface LinkStatsReport {
  pairId: string | null
  /** The pair's latest round-trip time (ms). */
  currentRttMs: number | null
  /** Cumulative: the sum of all STUN round trips (s) and their count, to average between polls. */
  totalRttS: number | null
  responsesReceived: number | null
  availableOutgoingKbps: number | null
  bytesSent: number | null
  bytesReceived: number | null
  /** Either end of the selected pair is a TURN relay candidate (null: unknown). */
  relayed: boolean | null
  sctp: SctpStats | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const scale = (v: number | null, k: number): number | null => (v === null ? null : v * k)

/** Picks the selected candidate pair and the SCTP transport out of a report. Null without a selected pair. */
export function parseLinkStats(report: StatsLike): LinkStatsReport | null {
  const byId = new Map<string, StatsRecord>()
  let selectedId: string | undefined
  let sctp: StatsRecord | undefined
  const pairs: StatsRecord[] = []
  report.forEach((r) => {
    byId.set(r.id, r)
    if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') selectedId ??= r.selectedCandidatePairId
    else if (r.type === 'candidate-pair') pairs.push(r)
    else if (r.type === 'sctp-transport') sctp ??= r
  })
  // Chrome names the pair from the transport; Firefox flags it `selected`; else the nominated, working one.
  const pair =
    (selectedId ? byId.get(selectedId) : undefined) ??
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => p.nominated === true && p.state === 'succeeded')
  if (!pair || pair.type !== 'candidate-pair') return null
  const type = (id: unknown) => (typeof id === 'string' ? byId.get(id)?.candidateType : undefined)
  const local = type(pair.localCandidateId)
  const remote = type(pair.remoteCandidateId)
  return {
    pairId: pair.id,
    currentRttMs: scale(num(pair.currentRoundTripTime), 1000),
    totalRttS: num(pair.totalRoundTripTime),
    responsesReceived: num(pair.responsesReceived),
    availableOutgoingKbps: scale(num(pair.availableOutgoingBitrate), 1 / 1000),
    bytesSent: num(pair.bytesSent),
    bytesReceived: num(pair.bytesReceived),
    relayed: local === undefined && remote === undefined ? null : local === 'relay' || remote === 'relay',
    sctp: sctp
      ? {
          congestionWindow: num(sctp.congestionWindow),
          receiverWindow: num(sctp.receiverWindow),
          smoothedRttMs: scale(num(sctp.smoothedRoundTripTime), 1000),
          unackData: num(sctp.unackData),
          mtu: num(sctp.mtu),
        }
      : null,
  }
}

/** Baseline: the lowest RTT over this window (long enough to have seen the path idle). */
export const RTT_BASELINE_WINDOW_MS = 120_000
/** No new RTT sample for this long: the connection's RTT is stale (Chrome refreshes every ~2.6 s). */
export const RTT_STALE_MS = 8000

/** One connection's derived stats, as of its latest poll. */
export interface LinkStats {
  /** Path RTT over the latest interval with STUN responses (ms). */
  rttMs: number | null
  /** Windowed minimum of rttMs (ms). */
  baselineMs: number | null
  /** RTT samples within the baseline window. */
  samples: number
  /** The RTT refreshed within RTT_STALE_MS. */
  fresh: boolean
  /** Wire send / receive rate since the previous poll (all channels, with SCTP/DTLS overhead). */
  sendKbps: number | null
  recvKbps: number | null
  availableOutgoingKbps: number | null
  relayed: boolean | null
  sctp: SctpStats | null
}

/**
 * Feeds successive reports of one connection; keeps its RTT history. The RTT of an interval is
 * the average of the STUN round trips that completed in it (Δ totalRoundTripTime / Δ responses),
 * else currentRoundTripTime when it changed (browsers without the totals).
 */
export class LinkStatsTracker {
  private prev: { at: number; r: LinkStatsReport } | null = null
  private history: { at: number; rttMs: number }[] = []
  private lastRttAt = -Infinity
  private latest: LinkStats | null = null

  constructor(
    private windowMs = RTT_BASELINE_WINDOW_MS,
    private staleMs = RTT_STALE_MS,
  ) {}

  update(r: LinkStatsReport, now: number): LinkStats {
    const prev = this.prev && this.prev.r.pairId === r.pairId ? this.prev : null
    let rtt: number | null = null
    if (prev && r.responsesReceived !== null && prev.r.responsesReceived !== null && r.totalRttS !== null && prev.r.totalRttS !== null) {
      const n = r.responsesReceived - prev.r.responsesReceived
      if (n > 0) rtt = ((r.totalRttS - prev.r.totalRttS) * 1000) / n
    } else if (r.currentRttMs !== null && (!prev || r.responsesReceived !== prev.r.responsesReceived || r.currentRttMs !== prev.r.currentRttMs)) {
      // First report, or no totals: take the latest value when it (or the response count) moved.
      rtt = r.currentRttMs
    }
    if (rtt !== null && rtt >= 0) {
      this.history.push({ at: now, rttMs: rtt })
      this.lastRttAt = now
    }
    while (this.history.length && now - this.history[0].at > this.windowMs) this.history.shift()
    const dtS = prev ? (now - prev.at) / 1000 : 0
    const rate = (a: number | null, b: number | null) => (dtS > 0 && a !== null && b !== null && a >= b ? ((a - b) * 8) / 1000 / dtS : null)
    const last = this.history.at(-1)
    this.latest = {
      rttMs: last?.rttMs ?? null,
      baselineMs: this.history.length ? Math.min(...this.history.map((h) => h.rttMs)) : null,
      samples: this.history.length,
      fresh: now - this.lastRttAt <= this.staleMs,
      sendKbps: rate(r.bytesSent, prev?.r.bytesSent ?? null),
      recvKbps: rate(r.bytesReceived, prev?.r.bytesReceived ?? null),
      availableOutgoingKbps: r.availableOutgoingKbps,
      relayed: r.relayed,
      sctp: r.sctp,
    }
    this.prev = { at: now, r }
    return this.latest
  }

  /** The latest derived stats (null before the first report), re-checked for staleness at `now`. */
  current(now: number): LinkStats | null {
    if (!this.latest) return null
    return { ...this.latest, fresh: now - this.lastRttAt <= this.staleMs }
  }
}

/** RTT inflation above which a path counts as queueing: max(floorMs, share × baseline). */
export function rttInflationThreshold(baselineMs: number, floorMs: number, share = 0.5): number {
  return Math.max(floorMs, share * baselineMs)
}

/** Need this many RTT samples in the window before trusting the baseline. */
export const RTT_MIN_SAMPLES = 3

/**
 * Queueing on the path to one peer, from its connections' stats. All connections of a pair share
 * the path, so it counts as inflated only when every connection with a fresh RTT and enough history
 * is (one connection's lone spike isn't queueing); `inflationMs` is the smallest. Null when no
 * connection qualifies: the RTT signal is unavailable.
 */
export function pathInflation(links: (LinkStats | null)[], floorMs: number): { inflationMs: number; inflated: boolean } | null {
  let out: { inflationMs: number; inflated: boolean } | null = null
  for (const l of links) {
    if (!l || !l.fresh || l.rttMs === null || l.baselineMs === null || l.samples < RTT_MIN_SAMPLES) continue
    const inflationMs = l.rttMs - l.baselineMs
    const inflated = inflationMs > rttInflationThreshold(l.baselineMs, floorMs)
    out = out ? { inflationMs: Math.min(out.inflationMs, inflationMs), inflated: out.inflated && inflated } : { inflationMs, inflated }
  }
  return out
}
