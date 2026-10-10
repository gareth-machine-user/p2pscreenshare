// The presenter's bitrate: what its uplink, its direct children and (with Auto quality) its
// audience can carry (session/congestion.ts), applied to its stream in steps.
import type { ChannelPublisher } from './channelPublisher'
import { stripeKbpsFor, type CapacityModel } from './capacity'
import { AudienceCap, audienceLimit, BitrateController, rateTarget, ViewerSettle, type RateTarget } from './congestion'
import type { PublishedStream } from './publishedStream'

/** The presenter's bitrate and what sets it, in numbers (presenter bar, Stats). */
export interface RateStatus {
  currentKbps: number
  chosenKbps: number
  limit: RateTarget['limit']
  targetKbps: number
  uplinkKbps: number | null
  medianPeerKbps: number | null
  feasibleKbps: number | null
  stalledLanes: number
}

export class PresenterRate {
  /** The stream adapts its bitrate to what the audience can carry (Auto quality). */
  autoBitrate = false
  /** The bitrate the stream should run at, and what limits it; null when not presenting. */
  target: RateTarget | null = null
  private ctl = new BitrateController()
  /** Auto quality's cap, apart from the chosen quality. */
  private audienceCap = new AudienceCap()
  /** Direct children count towards the median only once settled. */
  private settle = new ViewerSettle()

  constructor(
    private selfId: string,
    private capacity: CapacityModel,
  ) {}

  /** A new stream starts without the last one's audience cap. */
  newStream(): void {
    this.audienceCap = new AudienceCap()
  }

  /**
   * Auto quality for a presenter: when the audience's upload can't carry the stream for 10 s, the
   * publisher's sharing controls warn, and with Auto quality the bitrate is capped at what it can
   * carry (adapt applies it). The chosen quality stays the ceiling, so the cap lifts once the
   * audience carries the stream again.
   */
  checkAudience(s: PublishedStream | null, now: number): void {
    const full = s?.full
    if (!s || !full) return
    this.audienceCap.step(now, this.autoBitrate, full.limited, s.ceilingKbps)
  }

  /**
   * The presenter's bitrate (session/congestion.ts): 85% of what the wire budget per direct child
   * carries, the budget being the smaller of the uplink's capacity shared by the direct children
   * and the median capacity of the peers it feeds directly (those fed for SETTLE_MS). Runs
   * on each 2 s window.
   */
  adapt(s: PublishedStream | null, now: number): void {
    const full = s?.full
    if (!s || !full) {
      this.target = null
      return
    }
    const edges = this.directEdges(full)
    const stripes = full.stripes
    this.settle.update(now, edges.byPeer.keys())
    const peerKbps = [...edges.byPeer].map(([peer, e]) => {
      // A newly fed child doesn't push back yet: its first windows say little.
      if (!this.settle.settled(now, peer)) return null
      const c = this.capacity.peer(peer)
      // A peer fed only some stripes needs only that share of a full copy.
      return c.bound && c.kbps !== null ? (c.kbps * stripes) / e : null
    })
    const t = rateTarget({
      chosenKbps: s.ceilingKbps,
      // The audience's relay slots: never climb past what they carry (Auto quality cuts to it).
      audienceKbps: audienceLimit(this.autoBitrate ? this.audienceCap.kbps : null, full.limited, full.kbps),
      uplinkKbps: this.capacity.uplinkKbps,
      directChildren: edges.children,
      peerKbps,
      wireAt: (v) => stripes * stripeKbpsFor(v, full.k, full.withAudio),
    })
    this.target = t
    const next = this.ctl.step(now, full.kbps, t)
    if (next !== null) s.adaptBitrate(next)
  }

  /**
   * This peer's direct children in its own full channel: (child, stripe) edges per child, and
   * edges / stripes (at least one full copy once anyone watches).
   */
  private directEdges(full: ChannelPublisher): { byPeer: Map<string, number>; children: number } {
    const byPeer = new Map<string, number>()
    let n = 0
    for (const [child, ps] of Object.entries(full.topology.parents)) {
      for (const p of ps) {
        if (p !== this.selfId) continue
        n++
        byPeer.set(child, (byPeer.get(child) ?? 0) + 1)
      }
    }
    return { byPeer, children: Math.max(n, full.subscribers.size ? full.stripes : 0) / full.stripes }
  }

  /** The bitrate and what sets it, in numbers. Null when not presenting. */
  status(s: PublishedStream | null, stalledLanes: number): RateStatus | null {
    const full = s?.full
    if (!s || !full) return null
    const t = this.target
    return {
      currentKbps: full.kbps,
      chosenKbps: s.ceilingKbps,
      limit: t?.limit ?? 'chosen',
      targetKbps: Math.round(t?.kbps ?? s.ceilingKbps),
      uplinkKbps: this.capacity.uplinkKbps === null ? null : Math.round(this.capacity.uplinkKbps),
      medianPeerKbps: t?.medianPeerKbps == null ? null : Math.round(t.medianPeerKbps),
      feasibleKbps: full.limited?.feasibleKbps ?? null,
      stalledLanes,
    }
  }
}
