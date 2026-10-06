// One watched channel: playback, its position in the channel's trees, and failure detection. Tree
// commands come only from the channel's publisher (checked by the session).
import { Player } from '../media/player'
import { Reassembler } from '../media/reassembler'
import type { Mesh } from '../mesh/mesh'
import type { ChannelAnnouncement } from '../mesh/records'
import { wallClock } from '../net/clock'
import type { Fragment } from '../proto/framing'
import type { LossRates, PeerMsg, PublisherMsg, StripeStat, SubscriberMsg, SubscriberStats, UplinkRates } from '../proto/messages'
import { RateWindow, round1 } from './rates'
import { REPLAY_REQUEST_MIN_MS, treeKey, type RelayNode } from '../relay/relayNode'
import { after, every } from '../net/ticker'
import { tuning } from '../tuning'

const HEALTH_INTERVAL_MS = 250
const STATS_INTERVAL_MS = 2000
/**
 * A stripe silent this long means its parent is gone or stalled (see tuning.ts). Reattaching reuses
 * an existing mesh link, so a false alarm costs little; the publisher re-encodes the last frame
 * every 400 ms while the screen is idle, so a live stripe is never this quiet.
 */
export const STRIPE_SILENCE_MS = tuning.stripeSilenceMs
const PARENT_GRACE_MS = 3000
/** Extra time allowed for a parent whose mesh link is still connecting. */
const LINK_SETUP_GRACE_MS = 8000
const REATTACH_COOLDOWN_MS = 4000
const RESUBSCRIBE_MS = 10_000
/** At most one keyframe request per this interval (the decode chain often breaks in bursts). */
const KEY_REQUEST_INTERVAL_MS = 500
/**
 * A broken decode chain is first repaired from the stripe parents' GOP caches (`need-gop`); only if
 * the decoder still waits for a keyframe this long after asking does the publisher get `need-key`
 * (a keyframe costs every viewer bandwidth and, in constant-bitrate mode, a blurry moment).
 */
export const GOP_REPLAY_TIMEOUT_MS = 1000
/** How long replayed duplicates are assembled again after a `need-gop` (they queue behind live media). */
const REPLAY_EXPECT_MS = tuning.replayMaxAgeMs + 1000

export interface SubscriptionContext {
  readonly selfId: string
  readonly mesh: Mesh
  readonly relay: RelayNode
  /** Debug upload cap, reported in stats. */
  readonly capKbps: number | null
  capacityKbps(): number | null
  uplinkSample(): { kbps: number; dropRate: number }
  /** This peer's uplink over the last window (drops by layer, queueing delay). */
  uplinkRates(): UplinkRates | null
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
  /** Where frames went missing, per second over the last stats window. */
  loss: LossRates | null = null
  private framesIn = 0
  private lossWindow = new RateWindow<LossRates>()

  private reassembler: Reassembler
  private pendingOk = new Map<number, string>()
  private parentSetAt = new Map<number, number>()
  private lastReattach = new Map<number, number>()
  private lastKeyRequest = 0
  private lastGopRequest = -Infinity
  /** Cancels the pending check whether the replay repaired the chain. */
  private escalation: (() => void) | null = null
  private frameFirstSeen = new Map<number, { at: number; stripes: Set<number> }>()
  private timers: (() => void)[] = []
  private closed = false

  constructor(
    readonly channel: number,
    readonly publisher: string,
    ann: ChannelAnnouncement,
    private ctx: SubscriptionContext,
  ) {
    this.ann = ann
    this.player = new Player(null, () => this.requestKeyframe())
    this.reassembler = new Reassembler((f) => {
      if (!f.audio) this.framesIn++
      this.player.push(f)
    })
    this.setAnnouncement(ann)
    this.subscribe()
    this.timers.push(every(HEALTH_INTERVAL_MS, () => this.checkHealth()))
    this.timers.push(every(STATS_INTERVAL_MS, () => void this.sendStats()))
    this.timers.push(every(RESUBSCRIBE_MS, () => this.subscribe()))
    this.timers.push(every(15_000, () => void this.syncClock()))
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
    // Replays are old frames arriving now: they say nothing about a stripe's lateness.
    if (!h.audio && !h.replay) this.trackLateness(h.frameSeq, h.stripe, performance.now())
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

  /**
   * The decode chain broke (or the decoder was rebuilt). First asks each stripe parent to replay its
   * cached GOP; if the decoder still waits for a keyframe GOP_REPLAY_TIMEOUT_MS later, asks the
   * publisher for one. A break while a replay was asked for recently only (re)arms that check.
   */
  private requestKeyframe(): void {
    if (this.closed) return
    const now = performance.now()
    if (now - this.lastGopRequest >= REPLAY_REQUEST_MIN_MS) {
      if (!this.requestGop()) {
        this.requestKeyFromPublisher() // no parents to ask
        return
      }
      this.lastGopRequest = now
      this.escalation?.()
      this.escalation = null
    }
    this.escalation ??= after(GOP_REPLAY_TIMEOUT_MS, () => {
      this.escalation = null
      if (!this.closed && this.player.scheduler.waitingForKeyframe) this.requestKeyFromPublisher()
    })
  }

  /** Sends `need-gop` to every current stripe parent; false if there are none. */
  private requestGop(): boolean {
    const byParent = new Map<string, number[]>()
    this.parents.forEach((p, s) => {
      if (p) byParent.set(p, [...(byParent.get(p) ?? []), s])
    })
    if (!byParent.size) return false
    const stripes = [...byParent.values()].flat()
    this.ctx.relay.expectReplay(this.channel, stripes)
    this.reassembler.expectReplay(wallClock(), REPLAY_EXPECT_MS)
    for (const [parent, s] of byParent) this.ctx.mesh.sendApp(parent, { t: 'need-gop', ch: this.channel, stripes: s } satisfies PeerMsg)
    return true
  }

  private requestKeyFromPublisher(): void {
    const now = performance.now()
    if (now - this.lastKeyRequest < KEY_REQUEST_INTERVAL_MS) return
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
        // A lost or timed-out ping: the remaining attempts (or the next sync) cover it.
      }
    }
    if (best) this.player.clockOffset = best.offset
  }

  private sampleLoss(): LossRates {
    const p = this.player.stats
    const r = this.lossWindow.sample({
      incomingFps: this.framesIn,
      incomplete: this.reassembler.incomplete,
      late: p.late,
      undecodable: p.undecodable,
      skipped: p.skipped,
      notRendered: p.notRendered,
    })
    const out = {} as LossRates
    for (const k of Object.keys(r) as (keyof LossRates)[]) out[k] = round1(r[k])
    return out
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
      loss: this.loss ?? undefined,
      uplinkRates: this.ctx.uplinkRates() ?? undefined,
    }
  }

  private async sendStats(): Promise<void> {
    this.loss = this.sampleLoss()
    const stats = this.stats
    this.lastStats = stats
    this.send({ t: 'stats', ch: this.channel, stats })
    this.ctx.onChange()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.send({ t: 'unsubscribe', ch: this.channel })
    this.timers.forEach((cancel) => cancel())
    this.escalation?.()
    this.player.close()
    this.ctx.relay.dropChannel(this.channel)
  }
}
