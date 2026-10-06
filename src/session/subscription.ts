// One watched channel: playback, its position in the channel's trees, and failure detection. Tree
// commands come only from the channel's publisher (checked by the session).
import { Player } from '../media/player'
import { Reassembler } from '../media/reassembler'
import type { Mesh } from '../mesh/mesh'
import type { ChannelAnnouncement } from '../mesh/records'
import { wallClock } from '../net/clock'
import type { Fragment } from '../proto/framing'
import type { PublisherMsg, StripeStat, SubscriberMsg, SubscriberStats } from '../proto/messages'
import { treeKey, type RelayNode } from '../relay/relayNode'

const HEALTH_INTERVAL_MS = 250
const STATS_INTERVAL_MS = 2000
/** A stripe silent this long means its parent is gone or stalled. */
export const STRIPE_SILENCE_MS = 2000
const PARENT_GRACE_MS = 3000
/** Extra time allowed for a parent whose mesh link is still connecting. */
const LINK_SETUP_GRACE_MS = 8000
const REATTACH_COOLDOWN_MS = 4000
const RESUBSCRIBE_MS = 10_000

export interface SubscriptionContext {
  readonly selfId: string
  readonly mesh: Mesh
  readonly relay: RelayNode
  /** Debug upload cap, reported in stats. */
  readonly capKbps: number | null
  capacityKbps(): number | null
  uplinkSample(): { kbps: number; dropRate: number }
  onChange(): void
}

export class Subscription {
  readonly player: Player
  parents: (string | null)[] = []
  home: number | null = null
  depth: number[] = []
  ann: ChannelAnnouncement
  lastStats: SubscriberStats | null = null
  /** Per-stripe smoothed lateness behind the earliest stripe (ms). */
  readonly lateMs: number[] = []

  private reassembler: Reassembler
  private pendingOk = new Map<number, string>()
  private parentSetAt = new Map<number, number>()
  private lastReattach = new Map<number, number>()
  private lastKeyRequest = 0
  private frameFirstSeen = new Map<number, { at: number; stripes: Set<number> }>()
  private timers: ReturnType<typeof setInterval>[] = []
  private closed = false

  constructor(
    readonly channel: number,
    readonly publisher: string,
    ann: ChannelAnnouncement,
    private ctx: SubscriptionContext,
  ) {
    this.ann = ann
    this.player = new Player(null, () => this.requestKeyframe())
    this.reassembler = new Reassembler((f) => this.player.push(f))
    this.setAnnouncement(ann)
    this.subscribe()
    this.timers.push(setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS))
    this.timers.push(setInterval(() => void this.sendStats(), STATS_INTERVAL_MS))
    this.timers.push(setInterval(() => this.subscribe(), RESUBSCRIBE_MS))
    this.timers.push(setInterval(() => void this.syncClock(), 15_000))
    void this.syncClock()
  }

  get stripes(): number {
    return this.ann.k + this.ann.m
  }

  /** (Re)sends the subscription; the publisher treats repeats as a request to resend parents. */
  subscribe(): void {
    if (!this.closed) this.send({ t: 'subscribe', ch: this.channel })
  }

  setAnnouncement(ann: ChannelAnnouncement): void {
    this.ann = ann
    if (this.parents.length !== this.stripes) this.parents = new Array(this.stripes).fill(null)
    if (ann.stream) this.player.setStreamInfo(ann.stream)
  }

  private send(msg: SubscriberMsg): void {
    this.ctx.mesh.sendApp(this.publisher, msg)
  }

  onFragment(frag: Fragment, from: string): void {
    const now = wallClock()
    this.reassembler.push(frag, now)
    const h = frag.header
    if (!h.audio) this.trackLateness(h.frameSeq, h.stripe, performance.now())
    if (this.pendingOk.get(h.stripe) === from) {
      this.pendingOk.delete(h.stripe)
      this.send({ t: 'stripe-ok', ch: this.channel, stripe: h.stripe, parent: from })
    }
  }

  /** Records how far behind the first stripe of each frame every other stripe arrives. */
  private trackLateness(seq: number, stripe: number, now: number): void {
    let f = this.frameFirstSeen.get(seq)
    if (!f) {
      f = { at: now, stripes: new Set() }
      this.frameFirstSeen.set(seq, f)
      if (this.frameFirstSeen.size > 120) this.frameFirstSeen.delete(this.frameFirstSeen.keys().next().value!)
    }
    if (f.stripes.has(stripe)) return
    f.stripes.add(stripe)
    const late = now - f.at
    this.lateMs[stripe] = (this.lateMs[stripe] ?? late) * 0.9 + late * 0.1
  }

  handle(msg: PublisherMsg): void {
    switch (msg.t) {
      case 'set-parent':
        if (msg.stripe >= this.stripes) return
        this.parents[msg.stripe] = msg.parent
        this.parentSetAt.set(msg.stripe, performance.now())
        if (msg.parent) this.pendingOk.set(msg.stripe, msg.parent)
        break
      case 'add-child':
        this.ctx.relay.addChild(this.channel, msg.stripe, msg.child)
        break
      case 'remove-child':
        this.ctx.relay.removeChild(this.channel, msg.stripe, msg.child)
        break
      case 'position':
        this.home = msg.home
        this.depth = msg.depth
        break
    }
    this.ctx.onChange()
  }

  private requestKeyframe(): void {
    const now = performance.now()
    if (now - this.lastKeyRequest < 500) return
    this.lastKeyRequest = now
    this.send({ t: 'need-key', ch: this.channel })
  }

  /** Detects silent stripes (dead or stalled parent) and asks the publisher for a new parent. */
  private checkHealth(): void {
    const now = performance.now()
    this.parents.forEach((parent, s) => {
      if (!parent) return
      const setAt = this.parentSetAt.get(s) ?? 0
      const linkOpen = parent === this.publisher || !!this.ctx.mesh.linkFor(parent)
      const connecting = this.ctx.mesh.linkStatus(parent) === 'connecting'
      if (now - setAt < (connecting ? LINK_SETUP_GRACE_MS : PARENT_GRACE_MS)) return
      const last = this.ctx.relay.lastRecv.get(treeKey(this.channel, s))
      if (last !== undefined && now - last < STRIPE_SILENCE_MS) return
      if (now - (this.lastReattach.get(s) ?? 0) < REATTACH_COOLDOWN_MS) return
      this.lastReattach.set(s, now)
      this.send({ t: 'reattach', ch: this.channel, stripe: s, linkOpen })
    })
  }

  private async syncClock(): Promise<void> {
    let best: { rtt: number; offset: number } | null = null
    for (let i = 0; i < 5; i++) {
      const link = this.ctx.mesh.linkFor(this.publisher)
      if (!link || this.closed) break
      try {
        const t0 = wallClock()
        const remote = await link.ping()
        const t1 = wallClock()
        const rtt = t1 - t0
        if (!best || rtt < best.rtt) best = { rtt, offset: remote - (t0 + t1) / 2 }
      } catch {
        // ignore
      }
    }
    if (best) this.player.clockOffset = best.offset
  }

  get stats(): SubscriberStats {
    const now = performance.now()
    const p = this.player.stats
    const up = this.ctx.uplinkSample()
    return {
      capKbps: this.ctx.capKbps,
      capacityKbps: this.ctx.capacityKbps(),
      uplinkKbps: up.kbps,
      uplinkDropRate: up.dropRate,
      stripes: this.parents.map((parent, s): StripeStat => {
        const last = this.ctx.relay.lastRecv.get(treeKey(this.channel, s))
        return {
          parent,
          lastRecvAgoMs: last === undefined ? null : now - last,
          rttMs: parent ? (this.ctx.mesh.linkFor(parent)?.rttMs ?? null) : null,
          lateMs: Math.round(this.lateMs[s] ?? 0),
        }
      }),
      children: this.ctx.relay.allChildren(this.channel).size,
      latencyMs: p.latencyMs,
      bufferMs: p.bufferMs,
      fps: p.fps,
      decodedFrames: p.decodedFrames,
      droppedFrames: p.droppedFrames,
      waitingForKeyframe: p.waitingForKeyframe,
    }
  }

  private async sendStats(): Promise<void> {
    const stats = this.stats
    this.lastStats = stats
    this.send({ t: 'stats', ch: this.channel, stats })
    this.ctx.onChange()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.send({ t: 'unsubscribe', ch: this.channel })
    this.timers.forEach(clearInterval)
    this.player.close()
    this.ctx.relay.dropChannel(this.channel)
  }
}
