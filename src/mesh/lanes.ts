// Media lanes: extra connections per mesh pair, so one pair's media isn't capped by the congestion
// window of a single SCTP association.
//
// Lane 0 is the pair's mesh connection; lanes 1..N-1 are extra RTCPeerConnections (lane.ts) with
// only a media and a bin channel. They are signaled over the pair's authenticated `ctl` channel
// (lane-offer / lane-answer / lane-close), never through the tracker or other peers, and the lower
// peer id offers (the mesh's rule). The offerer opens its lanes shortly after the mesh link opens,
// unless that link goes through TURN; the answerer declines lanes beyond its own setting, so a pair
// uses the smaller of the two settings. Lanes close with the mesh link (and so on leave, kick and
// ban). A failed lane is retried with backoff, at most a few times per pair, and a page creates at
// most LANE_BUDGET of them: Chromium allows 500 RTCPeerConnections per page, closed ones included.
//
// Stripe s of any channel goes over slot (s mod K) of the pair, K being 1 + the lanes that are
// open, connecting or waiting for a retry; a slot whose lane isn't open falls back to lane 0. So the
// mapping only changes when a lane is given up for good (or declined), not while one reconnects.
import type { MediaLink, ProbeLink } from '../net/link'
import { after } from '../net/ticker'
import type { LaneConn, LaneFactory } from './lane'
import type { PeerConn } from './meshConn'

export const MAX_LANES = 4
/** Connections per pair unless the page says otherwise (`lanes=N`). */
export const DEFAULT_LANES = 2
/** The offerer opens lanes this long after the mesh link opened (it carries the snapshot first). */
export const LANE_START_MS = 1000
/** Backoff before re-opening a failed lane, by failure count (1st, 2nd, ...). */
export const LANE_RETRY_MS = [5000, 30_000]
/** After this many lane failures with one peer, no more lanes to it (for this page's lifetime). */
export const LANE_MAX_FAILURES = 3
/** Most lanes one page creates in its lifetime (the Chromium per-page connection limit is 500). */
export const LANE_BUDGET = 200
const SDP_MAX = 64 * 1024

/** Lane signaling on a mesh link's `ctl` channel. */
export type LaneMsg =
  | { t: 'lane-offer'; i: number; sdp: string }
  | { t: 'lane-answer'; i: number; sdp: string }
  /** `d`: declined (don't retry). */
  | { t: 'lane-close'; i: number; d?: boolean }

export function isLaneMsg(m: unknown): m is LaneMsg {
  if (typeof m !== 'object' || m === null) return false
  const o = m as Record<string, unknown>
  if (!Number.isInteger(o.i) || (o.i as number) < 1 || (o.i as number) >= MAX_LANES) return false
  if (o.t === 'lane-offer' || o.t === 'lane-answer') return typeof o.sdp === 'string' && o.sdp.length > 0 && o.sdp.length <= SDP_MAX
  if (o.t === 'lane-close') return o.d === undefined || typeof o.d === 'boolean'
  return false
}

/** Clamps a lane setting to 1..MAX_LANES (non-numbers: the default). */
export function clampLanes(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_LANES
  return Math.max(1, Math.min(MAX_LANES, Math.floor(n)))
}

interface Slot {
  lane: LaneConn | null
  /** Waiting to re-open after a failure (cancel function). */
  retry: (() => void) | null
}

interface Pair {
  primary: PeerConn
  offerer: boolean
  slots: Map<number, Slot>
  /** The selected path is relayed by TURN: no lanes. */
  relayed: boolean
  start: (() => void) | null
  closed: boolean
}

export interface LaneHost {
  readonly selfId: string
  readonly iceServers: RTCIceServer[]
  /** Connections wanted per pair (1 = lanes off). */
  readonly wanted: number
  connect: LaneFactory
  onMedia(data: Uint8Array, from: string): void
  onBinary(data: Uint8Array, from: string): void
  onBufferLow(): void
  onChange(): void
}

export class Lanes {
  private pairs = new Map<string, Pair>()
  /** Lane failures per peer, for the page's lifetime (survives the mesh link reconnecting). */
  private failures = new Map<string, number>()
  /** Lanes created by this page. */
  created = 0

  constructor(private host: LaneHost) {}

  /** The mesh link to a peer opened. */
  primaryOpened(conn: PeerConn): void {
    const id = conn.remoteId
    const prev = this.pairs.get(id)
    if (prev && prev.primary !== conn) this.teardown(prev)
    if (this.pairs.get(id)?.primary === conn) return
    const pair: Pair = { primary: conn, offerer: this.host.selfId < id, slots: new Map(), relayed: false, start: null, closed: false }
    this.pairs.set(id, pair)
    if (pair.offerer && this.host.wanted > 1) pair.start = after(LANE_START_MS, () => void this.start(pair))
  }

  /** The mesh link closed (or was replaced): its lanes go with it. */
  primaryClosed(conn: PeerConn): void {
    const pair = this.pairs.get(conn.remoteId)
    if (pair?.primary === conn) this.teardown(pair)
  }

  closeAll(): void {
    for (const pair of [...this.pairs.values()]) this.teardown(pair)
  }

  /** The link that carries `stripe` to `peer`: one of its lanes, or the mesh link itself. */
  linkFor(primary: PeerConn, stripe: number): MediaLink {
    const pair = this.pairs.get(primary.remoteId)
    if (!pair || pair.primary !== primary || !pair.slots.size) return primary
    const ids = [...pair.slots.keys()].sort((a, b) => a - b)
    const slot = (((stripe | 0) % (ids.length + 1)) + ids.length + 1) % (ids.length + 1)
    if (slot === 0) return primary
    const lane = pair.slots.get(ids[slot - 1])?.lane
    return lane?.isOpen ? lane : primary
  }

  /** Open lanes to a peer (not counting the mesh link). */
  openLanes(id: string): LaneConn[] {
    const out: LaneConn[] = []
    for (const s of this.pairs.get(id)?.slots.values() ?? []) if (s.lane?.isOpen) out.push(s.lane)
    return out
  }

  /** The probe links of a peer's open lanes. */
  probeLinks(id: string): ProbeLink[] {
    return this.openLanes(id).map((l) => l.probeLink)
  }

  relayed(id: string): boolean {
    return !!this.pairs.get(id)?.relayed
  }

  /** The peer a lane leads to, if `link` is one of the lanes. */
  peerOf(link: unknown): string | undefined {
    for (const [id, pair] of this.pairs) for (const s of pair.slots.values()) if (s.lane === link) return id
    return undefined
  }

  /** Lane signaling from `conn`'s peer (already validated with isLaneMsg). */
  handle(msg: LaneMsg, conn: PeerConn): void {
    const id = conn.remoteId
    const pair = this.pairs.get(id)
    if (!pair || pair.primary !== conn || pair.closed) {
      if (msg.t === 'lane-offer') conn.sendCtl({ t: 'lane-close', i: msg.i, d: true })
      return
    }
    switch (msg.t) {
      case 'lane-offer':
        void this.answer(pair, msg.i, msg.sdp)
        return
      case 'lane-answer': {
        const lane = pair.offerer ? pair.slots.get(msg.i)?.lane : null
        if (!lane || lane.state !== 'connecting') return
        lane.acceptAnswer(msg.sdp).catch(() => lane.close())
        return
      }
      case 'lane-close': {
        const slot = pair.slots.get(msg.i)
        if (!slot) return
        // Only an answerer declines.
        if (msg.d && pair.offerer) {
          // Declined: the peer runs fewer lanes. Not a failure, and not retried.
          this.detach(slot)
          slot.retry?.()
          pair.slots.delete(msg.i)
          this.host.onChange()
          return
        }
        const lane = slot.lane
        if (!lane) return
        this.lost(pair, msg.i, lane, false)
        return
      }
    }
  }

  private async start(pair: Pair): Promise<void> {
    pair.start = null
    if (pair.closed || !pair.primary.isOpen) return
    // Over TURN, extra connections would only add relay allocations (and the relay's limits).
    if (await pair.primary.usesRelay()) {
      pair.relayed = true
      this.host.onChange()
      return
    }
    for (let i = 1; i < this.host.wanted; i++) void this.offer(pair, i)
  }

  private canCreate(id: string): boolean {
    return this.created < LANE_BUDGET && (this.failures.get(id) ?? 0) < LANE_MAX_FAILURES
  }

  private newLane(pair: Pair, i: number, slot: Slot): LaneConn {
    const id = pair.primary.remoteId
    const lane = this.host.connect(this.host.iceServers, id, i)
    this.created++
    slot.lane = lane
    lane.onMedia = (data) => this.host.onMedia(data, id)
    lane.onBin = (data) => this.host.onBinary(data, id)
    lane.onBufferLow = () => this.host.onBufferLow()
    lane.onStateChange = (state) => {
      if (state === 'open') this.host.onChange()
      else if (state === 'closed' || state === 'failed') this.lost(pair, i, lane, true)
    }
    return lane
  }

  private async offer(pair: Pair, i: number): Promise<void> {
    if (pair.closed || !this.canCreate(pair.primary.remoteId)) {
      this.dropSlot(pair, i)
      return
    }
    let slot = pair.slots.get(i)
    if (!slot) pair.slots.set(i, (slot = { lane: null, retry: null }))
    slot.retry = null
    const lane = this.newLane(pair, i, slot)
    try {
      const sdp = await lane.createOffer()
      if (slot.lane !== lane || lane.state !== 'connecting' || pair.closed) return
      if (!pair.primary.sendCtl({ t: 'lane-offer', i, sdp })) return lane.close()
      // No answer within the deadline (or ICE failed): counts as a failure.
      lane.armTimeout()
    } catch (err) {
      console.warn('lane offer failed', err)
      lane.close()
    }
  }

  private async answer(pair: Pair, i: number, sdp: string): Promise<void> {
    const id = pair.primary.remoteId
    // Only the lower id offers: an offer from the other side is ignored (not declined, which would
    // close the lane of that index we opened).
    if (pair.offerer) return
    if (i >= this.host.wanted || this.created >= LANE_BUDGET) {
      pair.primary.sendCtl({ t: 'lane-close', i, d: true })
      return
    }
    // A new offer for a slot replaces whatever lane was there (the offerer re-opened it).
    const old = pair.slots.get(i)
    if (old) this.detach(old)
    const slot: Slot = { lane: null, retry: null }
    pair.slots.set(i, slot)
    const lane = this.newLane(pair, i, slot)
    try {
      const answer = await lane.acceptOffer(sdp)
      if (slot.lane !== lane || lane.state !== 'connecting' || pair.closed) return
      if (!pair.primary.sendCtl({ t: 'lane-answer', i, sdp: answer })) lane.close()
    } catch (err) {
      console.warn(`lane answer to ${id} failed`, err)
      lane.close()
    }
  }

  /**
   * A lane closed or failed. `notify`: tell the peer (it didn't tell us). The offerer counts the
   * failure and retries with backoff while the pair has failures to spare; the answerer forgets
   * the slot until a new offer comes.
   */
  private lost(pair: Pair, i: number, lane: LaneConn, notify: boolean): void {
    const slot = pair.slots.get(i)
    if (!slot || slot.lane !== lane) return
    this.detach(slot)
    if (pair.closed) return
    if (notify) pair.primary.sendCtl({ t: 'lane-close', i })
    if (!pair.offerer) {
      pair.slots.delete(i)
    } else {
      const id = pair.primary.remoteId
      const n = (this.failures.get(id) ?? 0) + 1
      this.failures.set(id, n)
      if (this.canCreate(id)) {
        const delay = LANE_RETRY_MS[Math.min(n - 1, LANE_RETRY_MS.length - 1)]
        slot.retry = after(delay, () => {
          if (pair.slots.get(i) === slot && !pair.closed && pair.primary.isOpen) void this.offer(pair, i)
        })
      } else {
        pair.slots.delete(i)
      }
    }
    this.host.onChange()
  }

  private dropSlot(pair: Pair, i: number): void {
    const slot = pair.slots.get(i)
    if (slot) this.detach(slot)
    pair.slots.delete(i)
    this.host.onChange()
  }

  /** Closes a slot's lane quietly (no failure counted, nothing sent). */
  private detach(slot: Slot): void {
    const lane = slot.lane
    slot.lane = null
    if (!lane) return
    lane.onStateChange = () => {}
    lane.onMedia = () => {}
    lane.onBin = () => {}
    lane.close()
  }

  private teardown(pair: Pair): void {
    pair.closed = true
    pair.start?.()
    pair.start = null
    for (const slot of pair.slots.values()) {
      slot.retry?.()
      this.detach(slot)
    }
    pair.slots.clear()
    if (this.pairs.get(pair.primary.remoteId) === pair) this.pairs.delete(pair.primary.remoteId)
    this.host.onChange()
  }
}
