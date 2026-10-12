// What this peer measures of its connections: the uplink's rates per window, each open mesh
// connection's capacity windows (session/capacity.ts) and getStats() history (net/linkStats.ts),
// and the per-peer figures the Peers and Topology panels show.
import type { PairConn } from '../mesh/dataConn'
import type { Mesh } from '../mesh/mesh'
import { LinkStatsTracker, parseLinkStats, pathInflation } from '../net/linkStats'
import type { Uplink } from '../net/uplink'
import type { UplinkRates } from '../proto/messages'
import { CapacityModel, FROZEN_LAG_MS, linkWindow, SETTLE_MS, type ConnWindow, type LinkSnap } from './capacity'
import type { HeadroomProbe } from './headroom'
import { RateWindow, round1 } from './rates'

/** Path RTT inflation shown as "+N ms" in the Peers panel, at least (display only). */
const RTT_QUEUE_SHOWN_MS = 40

/** The connection to a peer, as the Peers panel shows it (PeerSession.linkStatsFor). */
export interface LinkRow {
  /** Wire send rate (getStats bytesSent: carrier and ctl channel, with overhead). */
  sendKbps: number | null
  /** Wire receive rate (getStats bytesReceived). */
  recvKbps: number | null
  /** Live media handed to this connection over the last window. */
  mediaKbps: number | null
  /** What it delivered over the last window (media and probe padding), and what it can carry (capacity.ts). */
  deliveredKbps: number | null
  capKbps: number | null
  /** It was its own bottleneck at some point (a slow receiver, or its congestion window). */
  bound: boolean
  /** Its uplink queue never emptied over the last window: it carried all it could. */
  backlogged: boolean
  /** Path RTT (ICE candidate pair) now, and its 2-minute minimum. */
  rttMs: number | null
  baselineMs: number | null
  /** The RTT refreshed recently. */
  fresh: boolean
  /** Live-media queueing (uplink queue + send buffer) and drops/s over the last window. */
  queueMs: number | null
  drops: number | null
  /** The connection stalled recently (its carrier stopped taking bytes; net/uplink.ts STALL_MS). */
  stalled: boolean
  relayed: boolean | null
  /** The browser's bandwidth estimate (getStats availableOutgoingBitrate); capKbps is it, capped. */
  estimateKbps: number | null
}

/** One connection's last capacity window (session/capacity.ts linkWindow), rounded for display (Peers panel, Topology). */
interface LaneRate {
  mediaKbps: number
  deliveredKbps: number
  drops: number
  queueMs: number
  backlogged: boolean
  stalled: boolean
}

/** The uplink's cumulative counters that sampleUplink turns into rates. */
interface UplinkCounters {
  bytes: number
  items: number
  dropped: number
  /** Drops by layer: 0, 1, and 2 and above. */
  t0: number
  t1: number
  t2: number
  stalls: number
  queueSum: number
  queueN: number
}

function uplinkCounters(s: Uplink['stats']): UplinkCounters {
  const d = s.droppedByLayer
  return { bytes: s.sentBytes, items: s.sentItems, dropped: s.droppedItems, t0: d[0], t1: d[1], t2: d[2] + d[3], stalls: s.bufferStalls, queueSum: s.queueDelaySum, queueN: s.queueDelayN }
}


/** What is kept per open connection, in one place. */
interface ConnRecord {
  peer: string
  /** When it was first seen open (performance.now()). */
  openedAt: number
  /** Its getStats() history (net/linkStats.ts): path RTT, wire rates. */
  tracker: LinkStatsTracker
  /** The snapshot the last capacity window ended with, and that window's figures. */
  last: LinkSnap | null
  rate: LaneRate | null
}

export class ConnMetrics {
  /** Capacity per connection (the browser's estimates), per peer and of the uplink (session/capacity.ts). */
  readonly capacity = new CapacityModel()
  /** The uplink's send rate and drop ratio over the last window. */
  uplinkNow = { kbps: 0, dropRate: 0 }
  /** The uplink, per second over the last window (stats messages, Details panel). */
  uplinkStatsNow: UplinkRates | null = null
  /** Some media connection was backlogged in the last window (no headroom probe then). */
  backloggedNow = false
  /** The uplink's counters per second; the first window runs from construction (all zero then). */
  private uplinkWindow = new RateWindow<UplinkCounters>()
  /** Per open connection, refreshed by openConns(). */
  private connRecs = new Map<PairConn, ConnRecord>()
  private pollingStats = false

  constructor(
    private mesh: Mesh,
    private uplink: Uplink,
  ) {
    this.uplinkWindow.sample(uplinkCounters(uplink.stats))
  }

  /** The uplink's rates since the last call. */
  sampleUplink(now: number): void {
    const r = this.uplinkWindow.sample(uplinkCounters(this.uplink.stats), now)
    this.uplinkNow = {
      kbps: (r.bytes * 8) / 1000,
      dropRate: r.items + r.dropped > 0 ? r.dropped / (r.items + r.dropped) : 0,
    }
    this.uplinkStatsNow = {
      kbps: Math.round((r.bytes * 8) / 1000),
      drops: [round1(r.t0), round1(r.t1), round1(r.t2)],
      stalls: round1(r.stalls),
      queueMs: r.queueN > 0 ? Math.round(r.queueSum / r.queueN) : 0,
    }
  }

  /**
   * A connection without the browser's estimate, open less than SETTLE_MS: its backlog says nothing
   * of capacity yet (capacity.ts). One with an estimate never settles: its windows measure nothing.
   */
  private settling(conn: PairConn, r: ConnRecord, now: number): boolean {
    return now - r.openedAt < SETTLE_MS && !this.capacity.conn(conn)?.estimated
  }

  /**
   * Every open connection with its record. Records of connections that are no longer open are
   * dropped here, so this is the one place they are pruned.
   */
  openConns(): [PairConn, ConnRecord][] {
    const out: [PairConn, ConnRecord][] = []
    const seen = new Set<PairConn>()
    for (const peer of [...this.mesh.conns.keys()]) {
      const conn = this.mesh.linkFor(peer)
      if (!conn) continue
      seen.add(conn)
      let r = this.connRecs.get(conn)
      if (!r) this.connRecs.set(conn, (r = { peer, openedAt: performance.now(), tracker: new LinkStatsTracker(), last: null, rate: null }))
      out.push([conn, r])
    }
    for (const conn of this.connRecs.keys()) if (!seen.has(conn)) this.connRecs.delete(conn)
    this.capacity.retain(seen)
    return out
  }

  /**
   * One capacity window (session/capacity.ts): what each connection delivered since the last one,
   * whether it was backlogged or stalled meanwhile. Its backlog sets no capacity (`transient`)
   * while the connection is settling (no estimate, open less than SETTLE_MS), when it carried a catch-up replay,
   * or while `quiet` (the stream just changed quality). A window in which the page froze (the main
   * thread lagged FROZEN_LAG_MS or more) says nothing about the network and is left out.
   */
  sampleLinks(now: number, lagMs: number, quiet = false): void {
    const windows: ConnWindow[] = []
    for (const [conn, rec] of this.openConns()) {
      this.uplink.setPathRtt(conn, rec.tracker.current(now)?.baselineMs ?? null)
      const snap = this.uplink.snapshot(conn, conn.probeLink, now)
      const last = rec.last
      rec.last = snap
      rec.rate = null
      // A connection's counters restart if the uplink forgot it (closed and reopened).
      if (!last || snap.handed < last.handed || snap.items < last.items) continue
      const w = linkWindow(conn, rec.peer, last, snap)
      windows.push({ ...w, transient: w.transient || quiet || this.settling(conn, rec, now) })
      rec.rate = {
        mediaKbps: Math.round(w.mediaKbps),
        deliveredKbps: Math.round(w.kbps),
        drops: Math.round(w.dropsPerS * 10) / 10,
        queueMs: Math.round(w.queueMs),
        backlogged: w.backlogged,
        stalled: w.stalled,
      }
    }
    this.capacity.update(now, windows, { frozen: lagMs >= FROZEN_LAG_MS })
    this.backloggedNow = windows.some((w) => w.active && w.backlogged)
  }

  /**
   * Pushes background bytes onto every open connection for 1.5 s (session/headroom.ts) and takes
   * what each delivered as a backlogged window. False if no probe ran. A probe link is padding in
   * the connection's carrier frames, within the browser's estimate: the padding is what lets that
   * estimate grow while the stream sends less than it. Only a connection without an estimate
   * measures anything by it (CapacityModel).
   */
  async probe(headroom: HeadroomProbe): Promise<boolean> {
    const conns = this.openConns().filter(([conn]) => conn.probeLink.isOpen)
    const snap = () => new Map(conns.map(([conn]) => [conn, this.uplink.snapshot(conn, conn.probeLink)]))
    const r = await headroom.run(
      conns.map(([conn]) => conn.probeLink),
      snap,
    )
    if (!r) return false
    const windows: ConnWindow[] = []
    const now = performance.now()
    for (const [conn, rec] of conns) {
      const a = r.start.get(conn)
      const b = r.end.get(conn)
      if (!a || !b || !conn.isOpen || !conn.probeLink.isOpen) continue
      windows.push({ ...linkWindow(conn, rec.peer, a, b), active: true, backlogged: true, transient: this.settling(conn, rec, now) })
    }
    this.capacity.update(now, windows, { probe: true })
    return true
  }

  /**
   * Every open connection is still settling (no estimate, open less than SETTLE_MS): a probe now
   * would measure nothing. One with an estimate never holds a probe back: its padding grows it.
   */
  allSettling(now: number): boolean {
    const conns = this.openConns()
    return conns.length > 0 && conns.every(([c, r]) => this.settling(c, r, now))
  }

  /** No open connection to `peer` is settling (false with none). */
  peerSettled(peer: string, now: number): boolean {
    const rs = this.openConns().filter(([, r]) => r.peer === peer)
    return rs.length > 0 && rs.every(([c, r]) => !this.settling(c, r, now))
  }

  /**
   * Polls getStats() on every open connection into its tracker, and hands the browser's bandwidth
   * estimate (the carrier's: capped at the connection's maxKbps) to the capacity model as that
   * connection's capacity (null clears it).
   */
  async pollLinkStats(): Promise<void> {
    if (this.pollingStats) return
    this.pollingStats = true
    try {
      await Promise.all(
        this.openConns().map(async ([conn, rec]) => {
          const report = await conn.stats?.()
          const r = report && parseLinkStats(report)
          if (!r) return
          const stats = rec.tracker.update(r, performance.now())
          // Closed meanwhile (retain() already dropped it): don't bring its estimate back.
          const est = stats.availableKbps
          const known = est === null || conn.maxKbps === undefined ? est : Math.min(est, conn.maxKbps)
          if (conn.isOpen) this.capacity.setKnown(conn, rec.peer, known, performance.now())
        }),
      )
    } finally {
      this.pollingStats = false
    }
  }

  /** The mesh link's path RTT to `peer`, from the getStats polling (gossiped RTTs). */
  pathRttMs(peer: string): number | null {
    return this.recOf(peer)?.[1].tracker.current(performance.now())?.rttMs ?? null
  }

  /** When any open connection to `peer` last received bytes on the wire (getStats polling), if known. */
  pathHeardAt(peer: string): number | null {
    let at = -Infinity
    for (const r of this.connRecs.values()) if (r.peer === peer) at = Math.max(at, r.tracker.receivedAt)
    return Number.isFinite(at) ? at : null
  }

  /** Connections that stalled in the last window. */
  stalledLinks(): number {
    return [...this.connRecs.values()].filter((r) => r.rate?.stalled).length
  }

  /** The record of the open connection to `peer`. */
  private recOf(peer: string): [PairConn, ConnRecord] | undefined {
    for (const e of this.connRecs) if (e[1].peer === peer) return e
    return undefined
  }

  /**
   * The connection to `peer` (Peers panel, e2e): getStats() path stats (RTT now and baseline, wire
   * rates, relayed, the browser's estimate) and the live-media queueing and drops of the last
   * window. Null without an open connection.
   */
  linkStatsFor(peer: string): LinkRow | null {
    const e = this.recOf(peer)
    if (!e) return null
    const [conn, rec] = e
    const kbps = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))
    const ms = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)
    const s = rec.tracker.current(performance.now())
    const r = rec.rate
    const cap = this.capacity.conn(conn)
    return {
      sendKbps: kbps(s?.sendKbps),
      recvKbps: kbps(s?.recvKbps),
      mediaKbps: r?.mediaKbps ?? null,
      deliveredKbps: r?.deliveredKbps ?? null,
      capKbps: cap?.kbps == null ? null : Math.round(cap.kbps),
      bound: cap?.bound ?? false,
      backlogged: r?.backlogged ?? false,
      rttMs: ms(s?.rttMs),
      baselineMs: ms(s?.baselineMs),
      fresh: s?.fresh ?? false,
      queueMs: r?.queueMs ?? null,
      drops: r?.drops ?? null,
      stalled: r?.stalled ?? false,
      relayed: s?.relayed ?? null,
      estimateKbps: kbps(s?.availableKbps),
    }
  }

  /**
   * This peer's live totals over the last poll (2 s): sent and received on the wire across all its
   * connections (getStats), falling back to the uplink's own media counter for sending.
   */
  liveRates(): { sendKbps: number | null; recvKbps: number | null } {
    const now = performance.now()
    let send: number | null = null
    let recv: number | null = null
    for (const rec of this.connRecs.values()) {
      const s = rec.tracker.current(now)
      if (s?.sendKbps != null) send = (send ?? 0) + s.sendKbps
      if (s?.recvKbps != null) recv = (recv ?? 0) + s.recvKbps
    }
    return { sendKbps: send ?? this.uplinkStatsNow?.kbps ?? null, recvKbps: recv }
  }

  /** The link from this peer to `peer` over the last window (Topology). */
  linkRate(peer: string): { drops: number; queueMs: number; backlogged: boolean; capKbps: number | null } | null {
    const r = this.recOf(peer)?.[1].rate
    if (!r) return null
    const cap = this.capacity.peer(peer).kbps
    return { drops: r.drops, queueMs: r.queueMs, backlogged: r.backlogged, capKbps: cap === null ? null : Math.round(cap) }
  }

  /** Path RTT inflation to `peer` over its baseline (display only: the Peers panel's "+N ms"). */
  pathQueueFor(peer: string): { inflationMs: number; queued: boolean } | null {
    const rec = this.recOf(peer)?.[1]
    const p = pathInflation([rec ? rec.tracker.current(performance.now()) : null], RTT_QUEUE_SHOWN_MS)
    return p ? { inflationMs: Math.round(p.inflationMs), queued: p.inflated } : null
  }
}
