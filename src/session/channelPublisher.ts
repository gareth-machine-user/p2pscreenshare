// The publisher side of one channel: its subscribers, the tree planner and its commands, and the
// failure handling around them (reattach batching, blame, make-before-break switches). Each
// publisher plans its own channels' trees, so the planner fails together with the tree's source:
// no leader election, no handover. Capture and encoding live in publishedStream.ts; nothing here
// needs WebCodecs or MediaStream, so the policy can be unit-tested (tests/channelPublisher.test.ts).
import { packetize, type EncodedFrame } from '../media/packetizer'
import type { Mesh } from '../mesh/mesh'
import type { ChannelAnnouncement } from '../mesh/records'
import { gzip } from '../mesh/envelope'
import { toBase64Url } from '../net/lobby'
import { signFrame } from '../proto/signing'
import type { EncoderRates, PublisherMsg, StreamInfo, SubscriberMsg, SubscriberStats, TopologyReport, UplinkRates } from '../proto/messages'
import type { RelayNode } from '../relay/relayNode'
import { emptyTopology, subtree, type ParentChange, type PlannerConfig, type PlannerPeer, type PlanResult, type Topology } from '../topology/model'
import { plan } from '../topology/planner'
import {
  ComplaintLog,
  defaultPlannerConfig,
  judgeComplaints,
  KeyframeGate,
  LATE_PARENT_AVOID_MS,
  LateParentTracker,
  PARENT_GRACE_MS,
  REATTACH_BATCH_MS,
  type Accusation,
  type LatenessSample,
  type StatsSnapshot,
} from '../topology/policy'
import { feasibilityRatio, feasibleBitrate, MAX_FANOUT, stripeKbpsFor } from './capacity'
import { after, every } from '../net/ticker'
import { tuning } from '../tuning'

/** What a publisher needs from the session it belongs to. */
export interface PublisherContext {
  readonly selfId: string
  readonly mesh: Mesh
  readonly relay: RelayNode
  readonly signingKey: CryptoKey
  /** Root child slots for one of this peer's channels (from its budget split). */
  rootSlots(channel: number): number
  /** A channel's announcement changed (codec config, deficit): re-gossip the record. */
  announce(): void
  /** This peer's encoder and uplink over the last window (Topology panel). */
  publisherStats(): { encoder: EncoderRates | null; uplink: UplinkRates | null }
  /** This peer's link to another, over the last window. */
  linkRate(peer: string): { drops: number; queueMs: number; congested: boolean } | null
  onChange(): void
}

const REPLAN_INTERVAL_MS = 2000
const REMOVAL_TIMEOUT_MS = 4000
const LINK_FAILED_AVOID_MS = 60_000
const SILENT_PARENT_AVOID_MS = 15_000
/**
 * After a relay fails, its whole subtree goes silent on that stripe. Descendants' reattach requests
 * within this window blame the upstream failure, not their (healthy) parent.
 */
const UPSTREAM_DISRUPTION_MS = 6000
/** A parent that children report as silent must answer a ping within this time. */
const LIVENESS_TIMEOUT_MS = 1200
/** A peer that failed a liveness ping stays out of the plan this long (or until it answers again). */
const SUSPECT_HOLD_MS = 3000
const TOPOLOGY_REPORT_MS = 3000
/** Stripe rates are sampled this often, and the last STRIPE_SAMPLES samples (10 s) are kept. */
const STRIPE_SAMPLE_MS = 250
const STRIPE_SAMPLES = 40
/** Audience upload counts as short when supply is below 90% of demand for this long. */
const SHORT_SUPPLY_FOR_MS = 10_000
/** At most this often, an overcommitted channel asks its subscribers to re-measure their upload. */
const REPROBE_ASK_MS = 60_000

export interface ChannelSubscriber {
  id: string
  /** When it subscribed (newcomers stay leaves for a few seconds). */
  joinedAt: number
  stats: SubscriberStats | null
  /** When `stats` arrived. */
  statsAt: number
  /** Recent failures while acting as a parent (lowers rank), decaying. */
  failures: number
  /** Peers this subscriber should not be linked to on this channel, with expiry time. */
  avoid: Map<string, number>
  /** In the current plan (subscribed, linked and answering). */
  active: boolean
  /** Out of the plan until then, after failing a liveness ping. */
  suspectUntil: number
}

export class ChannelPublisher {
  readonly startedAt = Date.now()
  readonly subscribers = new Map<string, ChannelSubscriber>()
  topology: Topology = emptyTopology()
  lastPlan: PlanResult | null = null
  totalChanges = 0
  stream: StreamInfo | null = null

  private pendingRemovals = new Map<string, { oldParent: string; cancel: () => void }>()
  private replanTimer: (() => void) | null = null
  private timers: (() => void)[] = []
  /** Which subscribers' keyframe requests the encoder honours (one lossy viewer can't force many). */
  private keyGate = new KeyframeGate()
  /** Recent "parent forwards nothing" complaints, to corroborate each other. */
  private complaints = new ComplaintLog()
  private lastPositions = new Map<string, string>()
  /** `${peer}:${stripe}` -> until when that peer's feed is known to be broken upstream. */
  private disruptedUntil = new Map<string, number>()
  /** Frames are signed in order, so fragments leave in capture order. */
  private signing: Promise<void> = Promise.resolve()
  private reattachQueue: { child: string; stripe: number; linkOpen: boolean; at: number }[] = []
  /** `${peer}:${stripe}` -> when that peer's parent there last changed. */
  private parentChangedAt = new Map<string, number>()
  private reattachTimer: (() => void) | null = null
  private topoWatchers = new Set<string>()
  private stopped = false
  /** Bytes emitted per stripe since the last measurement, and the smoothed result (kbps). */
  private stripeBytes: number[] = []
  /** Busiest stripe's rate in each recent quarter-second window (kbps), newest last. */
  private stripeSamples: number[] = []
  private measuredStripeKbps = 0
  private announcedStripeKbps = 0
  private lastAnnounceAt = 0
  private lastMeasureAt = performance.now()
  /** Excess lateness of parents, from children's reports, and which have been late too long. */
  private late = new LateParentTracker()
  private shortSince: number | null = null
  private lastReprobeAsk = 0
  /** Set while the audience can't carry this channel: a bitrate it could carry. */
  limited: { feasibleKbps: number; ratio: number } | null = null

  constructor(
    readonly id: number,
    readonly kind: 'full' | 'preview',
    readonly k: number,
    readonly m: number,
    /** Video bitrate; changed in place by quality changes and Auto quality. */
    public kbps: number,
    readonly withAudio: boolean,
    private ctx: PublisherContext,
    private requestKeyframe: () => void,
  ) {
    this.timers.push(every(REPLAN_INTERVAL_MS, () => this.replan()))
    this.timers.push(every(250, () => this.checkLiveness()))
    this.timers.push(every(TOPOLOGY_REPORT_MS, () => void this.sendTopology()))
    this.timers.push(every(STRIPE_SAMPLE_MS, () => this.measureStripes()))
  }

  /**
   * Encoders overshoot their target (keyframes, motion), and relays must carry the bursts, not
   * just the average: the stripe bitrate that relays plan their slots with is the larger of the
   * nominal one and the 90th percentile of quarter-second rates over the last 10 s.
   */
  private measureStripes(): void {
    const now = performance.now()
    const dt = now - this.lastMeasureAt
    this.lastMeasureAt = now
    if (dt <= 0) return
    this.stripeSamples.push((Math.max(0, ...this.stripeBytes) * 8) / dt)
    this.stripeBytes = []
    if (this.stripeSamples.length > STRIPE_SAMPLES) this.stripeSamples.shift()
    const sorted = [...this.stripeSamples].sort((a, b) => a - b)
    this.measuredStripeKbps = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]
    const kbps = this.stripeKbps
    if (now - this.lastAnnounceAt >= 2000 && Math.abs(kbps - this.announcedStripeKbps) > this.announcedStripeKbps * 0.1) {
      this.announcedStripeKbps = kbps
      this.lastAnnounceAt = now
      this.ctx.announce()
    }
  }

  get stripes(): number {
    return this.k + this.m
  }

  get stripeKbps(): number {
    return Math.max(stripeKbpsFor(this.kbps, this.k, this.withAudio), Math.round(this.measuredStripeKbps))
  }

  announcement(): ChannelAnnouncement {
    return {
      id: this.id,
      kind: this.kind,
      k: this.k,
      m: this.m,
      kbps: this.kbps,
      stripeKbps: this.stripeKbps,
      stream: this.stream,
      deficit: this.lastPlan?.overcommitted ?? 0,
      startedAt: this.startedAt,
    }
  }

  setStream(info: StreamInfo): void {
    this.stream = info
    this.ctx.announce()
  }

  emit(frame: EncodedFrame): void {
    if (this.stopped) return
    // Requested or scheduled, a keyframe serves every subscriber waiting for one.
    if (frame.key && !frame.audio) this.keyGate.onKeyframe(performance.now())
    const stripes = packetize(frame, this.k, this.m, this.id)
    stripes.forEach((frags, i) => {
      for (const raw of frags) this.stripeBytes[i] = (this.stripeBytes[i] ?? 0) + raw.byteLength
    })
    this.signing = this.signing
      .then(async () => {
        await signFrame(this.ctx.signingKey, stripes)
        if (this.stopped) return
        for (const frags of stripes) for (const raw of frags) this.ctx.relay.inject(raw)
      })
      .catch((e) => console.warn('signing failed', e))
  }

  private send(to: string, msg: PublisherMsg): void {
    this.ctx.mesh.sendApp(to, msg)
  }

  // --- subscribers -------------------------------------------------------------------------------

  handle(msg: SubscriberMsg, from: string): void {
    if (this.stopped) return
    if (msg.t === 'subscribe') {
      if (!this.subscribers.has(from)) {
        this.subscribers.set(from, {
          id: from,
          joinedAt: performance.now(),
          stats: null,
          statsAt: 0,
          failures: 0,
          avoid: new Map(),
          active: false,
          suspectUntil: 0,
        })
        this.lastPositions.delete(from)
        this.checkLiveness()
      } else {
        // A re-subscribe (e.g. after the subscriber lost its state): resend its parents.
        const parents = this.topology.parents[from]
        parents?.forEach((parent, stripe) => this.send(from, { t: 'set-parent', ch: this.id, stripe, parent }))
        this.lastPositions.delete(from)
      }
      this.ctx.onChange()
      return
    }
    const sub = this.subscribers.get(from)
    if (msg.t === 'unsubscribe') {
      this.removeSubscriber(from)
      return
    }
    if (!sub) return
    switch (msg.t) {
      case 'stats':
        sub.stats = msg.stats
        sub.statsAt = performance.now()
        break
      case 'stripe-ok':
        this.completeRemoval(from, msg.stripe, msg.parent)
        return
      case 'reattach':
        this.queueReattach(from, msg.stripe, msg.linkOpen)
        return
      case 'need-key':
        if (this.keyGate.request(from, performance.now())) this.requestKeyframe()
        return
      case 'topo-req':
        if (msg.on) {
          this.topoWatchers.add(from)
          void this.sendTopology(from)
        } else {
          this.topoWatchers.delete(from)
        }
        return
    }
    this.ctx.onChange()
  }

  /** A member left the lobby (or its link to us closed for good). */
  removeSubscriber(id: string): void {
    const sub = this.subscribers.get(id)
    if (!sub) return
    this.deactivate(sub)
    this.subscribers.delete(id)
    for (let s = 0; s < this.stripes; s++) this.parentChangedAt.delete(`${id}:${s}`)
    this.keyGate.forget(id)
    this.complaints.forget(id)
    this.topoWatchers.delete(id)
    this.lastPositions.delete(id)
    this.scheduleReplan(0)
    this.ctx.onChange()
  }

  /**
   * Keeps the plan to subscribers that are linked and answering. The publisher reacts to its own
   * direct link state immediately, without waiting for gossip; a peer whose link recovers rejoins.
   */
  private checkLiveness(): void {
    const now = performance.now()
    for (const sub of this.subscribers.values()) {
      const alive = !!this.ctx.mesh.linkFor(sub.id) && !this.ctx.mesh.isSuspected(sub.id) && now >= sub.suspectUntil
      if (alive && !sub.active) {
        sub.active = true
        this.scheduleReplan()
      } else if (!alive && sub.active) {
        this.deactivate(sub)
        this.scheduleReplan(0)
      }
    }
  }

  /** Takes a subscriber out of the trees: its parents stop feeding it, its subtree isn't blamed. */
  private deactivate(sub: ChannelSubscriber): void {
    sub.active = false
    const id = sub.id
    // Only this channel's trees: the peer may still watch this publisher's other channel.
    this.ctx.relay.removePeer(id, this.id)
    // Stop the departed peer's parents from pushing stripes into a dead link (WebRTC may take
    // tens of seconds to notice), including parents that were still being phased out.
    const parents = this.topology.parents[id] ?? []
    parents.forEach((parent, stripe) => {
      if (parent) this.removeEdge(parent, id, stripe)
      // Its subtree is about to go silent; that's not their parents' fault.
      this.markSubtreeDisrupted(id, stripe)
    })
    for (const [key, pr] of this.pendingRemovals) {
      const [child, stripe] = key.split(':')
      if (child === id || pr.oldParent === id) {
        pr.cancel()
        this.pendingRemovals.delete(key)
        if (child === id) this.removeEdge(pr.oldParent, id, Number(stripe))
      }
    }
    // Forget its place, so it is replanned from scratch when it comes back.
    const parentsCopy = { ...this.topology.parents }
    delete parentsCopy[id]
    const home = { ...this.topology.home }
    delete home[id]
    this.topology = { parents: parentsCopy, home }
    this.lastPositions.delete(id)
  }

  // --- failure handling --------------------------------------------------------------------------

  private queueReattach(child: string, stripe: number, linkOpen: boolean): void {
    this.reattachQueue.push({ child, stripe, linkOpen, at: performance.now() })
    if (this.reattachTimer === null) {
      this.reattachTimer = after(REATTACH_BATCH_MS, () => this.processReattaches())
    }
  }

  private processReattaches(): void {
    this.reattachTimer = null
    const batch = this.reattachQueue.splice(0)
    const depth = (r: { child: string; stripe: number }) => this.lastPlan?.depth[r.child]?.[r.stripe] ?? 0
    batch.sort((a, b) => depth(a) - depth(b))
    const now = performance.now()
    let changed = false
    /** linkOpen complaints about relays, judged once the whole batch is known. */
    const accused: Accusation[] = []
    for (const { child, stripe, linkOpen, at } of batch) {
      const sub = this.subscribers.get(child)
      if (!sub?.active) continue
      // Sent before the child heard of its new parent: it is about the old one, and handled.
      if (at - (this.parentChangedAt.get(`${child}:${stripe}`) ?? -Infinity) < PARENT_GRACE_MS) continue
      const parent = this.topology.parents[child]?.[stripe]
      // The parent is itself starved by an upstream failure that is already being handled:
      // keep this child where it is (the parent's feed will resume).
      if (linkOpen && parent && this.isDisrupted(parent, stripe)) continue
      // This child's feed is broken, and everything below it is going silent as well.
      this.markSubtreeDisrupted(child, stripe, true)
      if (parent && parent !== this.ctx.selfId) {
        // Link up but nothing forwarded: the parent may be unreliable (judged below).
        // Link not up: this pair can't connect (avoid it for longer).
        // Either way, pick a different parent for this stripe.
        if (linkOpen && this.subscribers.has(parent)) accused.push({ child, parent, stripe, now })
        sub.avoid.set(parent, now + (linkOpen ? SILENT_PARENT_AVOID_MS : LINK_FAILED_AVOID_MS))
      }
      changed = true
    }
    const suspects = this.judgeParents(accused)
    if (changed) this.scheduleReplan(0)
    for (const p of suspects) void this.checkAlive(p)
  }

  /**
   * One child's complaint lowers a relay's rank for everyone, so it must not come from the child's
   * own bad downlink: a parent is blamed only on corroboration (judgeComplaints). Returns the
   * blamed parents, to be pinged.
   */
  private judgeParents(accused: Accusation[]): Set<string> {
    const snapshot = (id: string): StatsSnapshot | null => {
      const sub = this.subscribers.get(id)
      return sub?.stats ? { at: sub.statsAt, stripes: sub.stats.stripes } : null
    }
    const blamed = new Set<string>()
    for (const c of judgeComplaints(accused, this.complaints, snapshot, performance.now(), tuning.stripeSilenceMs / 2)) {
      const pp = this.subscribers.get(c.parent)
      if (!pp) continue
      // The parent is unreliable: rank it lower, and check that it's still there.
      pp.failures++
      blamed.add(c.parent)
    }
    return blamed
  }

  /**
   * A vanished peer's link can look open for a while. When children report a silent parent, ping
   * it; no answer means it's gone, which frees its slots for the replan right away.
   */
  private async checkAlive(id: string): Promise<void> {
    try {
      const link = this.ctx.mesh.linkFor(id)
      if (!link) throw new Error('no link')
      await link.ping(LIVENESS_TIMEOUT_MS)
    } catch {
      const sub = this.subscribers.get(id)
      if (!sub) return
      sub.suspectUntil = performance.now() + SUSPECT_HOLD_MS
      if (sub.active) {
        this.deactivate(sub)
        this.scheduleReplan(0)
      }
    }
  }

  private markSubtreeDisrupted(root: string, stripe: number, includeRoot = false): void {
    const until = performance.now() + UPSTREAM_DISRUPTION_MS
    const nodes = subtree(this.topology, root, stripe)
    if (includeRoot) nodes.push(root)
    for (const n of nodes) {
      const key = `${n}:${stripe}`
      this.disruptedUntil.set(key, Math.max(this.disruptedUntil.get(key) ?? 0, until))
    }
  }

  private isDisrupted(peer: string, stripe: number): boolean {
    const key = `${peer}:${stripe}`
    const until = this.disruptedUntil.get(key)
    if (until === undefined) return false
    if (performance.now() < until) return true
    this.disruptedUntil.delete(key)
    return false
  }

  // --- planning ----------------------------------------------------------------------------------

  private scheduleReplan(delay = 50): void {
    if (this.replanTimer !== null) {
      if (delay > 0) return
      this.replanTimer()
    }
    this.replanTimer = after(delay, () => {
      this.replanTimer = null
      this.replan()
    })
  }

  /** Slots a subscriber offered for this channel in its gossip record. */
  offeredSlots(id: string): number {
    return this.ctx.mesh.member(id)?.offers[String(this.id)] ?? 0
  }

  /** Excess lateness (ms) per `${parent}:${stripe}`, from children's reports. */
  get lateness(): ReadonlyMap<string, number> {
    return this.late.lateness
  }

  get plannerConfig(): PlannerConfig {
    const mesh = this.ctx.mesh
    return defaultPlannerConfig({
      hostId: this.ctx.selfId,
      k: this.k,
      m: this.m,
      rootSlots: this.ctx.rootSlots(this.id),
      maxFanout: MAX_FANOUT,
      rtt: (a, b) => mesh.member(a)?.rtt[b] ?? mesh.member(b)?.rtt[a] ?? null,
      lateness: (parent, stripe) => this.late.get(parent, stripe),
    })
  }

  /**
   * How much later a parent's children receive a stripe than the parent itself does, averaged over
   * its children. A parent late by more than LATE_PARENT_MS for 10 s loses its children there.
   */
  private updateLateness(now: number): void {
    const samples: LatenessSample[] = []
    for (const sub of this.subscribers.values()) {
      if (!sub.active || !sub.stats) continue
      sub.stats.stripes.forEach((st, s) => {
        const p = st.parent
        if (!p || p === this.ctx.selfId) return
        const own = this.subscribers.get(p)?.stats?.stripes[s]?.lateMs ?? 0
        samples.push({ parent: p, stripe: s, lateMs: st.lateMs, parentLateMs: own })
      })
    }
    for (const { parent, stripe } of this.late.update(samples, now)) {
      for (const sub of this.subscribers.values()) {
        if (this.topology.parents[sub.id]?.[stripe] === parent) sub.avoid.set(parent, now + LATE_PARENT_AVOID_MS)
      }
    }
  }

  /** Whether the audience's offered slots can carry this channel (warns the publisher if not). */
  private updateFeasibility(now: number): void {
    const active = [...this.subscribers.values()].filter((s) => s.active)
    const supply = this.ctx.rootSlots(this.id) + active.reduce((a, s) => a + Math.min(MAX_FANOUT, this.offeredSlots(s.id)), 0)
    const ratio = feasibilityRatio(active.length, this.stripes, supply)
    if (ratio >= 0.9) {
      this.shortSince = null
      if (this.limited) {
        this.limited = null
        this.ctx.onChange()
      }
      return
    }
    this.shortSince ??= now
    if (now - this.shortSince >= SHORT_SUPPLY_FOR_MS) {
      const next = { feasibleKbps: feasibleBitrate(this.kbps, ratio), ratio }
      if (next.feasibleKbps !== this.limited?.feasibleKbps) {
        this.limited = next
        this.ctx.onChange()
      }
    }
  }

  replan(): void {
    if (this.stopped) return
    const now = performance.now()
    this.updateLateness(now)
    this.updateFeasibility(now)
    for (const [key, until] of this.disruptedUntil) if (now > until) this.disruptedUntil.delete(key)
    const mesh = this.ctx.mesh
    const peers: PlannerPeer[] = []
    for (const sub of this.subscribers.values()) {
      for (const [id, until] of sub.avoid) if (now > until) sub.avoid.delete(id)
      sub.failures *= 0.95
      if (!sub.active) continue
      // Edges only between pairs with an open mesh link: never across a pair that failed, and not
      // to a joiner that is still meshing in (it would see silence and blame a healthy parent).
      const unreachable = new Set(mesh.member(sub.id)?.unreachable ?? [])
      for (const other of this.subscribers.keys()) {
        if (other !== sub.id && (mesh.member(other)?.unreachable.includes(sub.id) || !mesh.linked(sub.id, other))) unreachable.add(other)
      }
      if (mesh.record.unreachable.includes(sub.id)) unreachable.add(this.ctx.selfId)
      peers.push({
        id: sub.id,
        slots: this.offeredSlots(sub.id),
        joinedAt: sub.joinedAt,
        failures: sub.failures,
        avoid: [...sub.avoid.keys(), ...unreachable],
        starved: [...Array(this.stripes).keys()].filter((st) => this.isDisrupted(sub.id, st)),
      })
    }
    const result = plan(peers, this.topology, this.plannerConfig, now)
    const deficitChanged = (this.lastPlan?.overcommitted ?? 0) !== result.overcommitted
    this.lastPlan = result
    this.topology = result.topology
    this.totalChanges += result.changes.length
    for (const c of result.changes) this.apply(c)
    this.sendPositions(result)
    if (deficitChanged) this.ctx.announce()
    // Overcommitted: maybe the audience's estimates are stale (a network got better). Ask.
    if (result.overcommitted > 0 && now - this.lastReprobeAsk > REPROBE_ASK_MS) {
      this.lastReprobeAsk = now
      for (const sub of this.subscribers.values()) if (sub.active) this.send(sub.id, { t: 'reprobe', ch: this.id })
    }
    this.ctx.onChange()
  }

  private apply(c: ParentChange): void {
    const key = `${c.peer}:${c.stripe}`
    this.parentChangedAt.set(key, performance.now())
    if (c.to !== null) this.addEdge(c.to, c.peer, c.stripe)
    this.send(c.peer, { t: 'set-parent', ch: this.id, stripe: c.stripe, parent: c.to })

    const prev = this.pendingRemovals.get(key)
    let from = c.from
    if (prev) {
      prev.cancel()
      this.pendingRemovals.delete(key)
      if (prev.oldParent !== c.to) {
        // The parent being replaced never reported delivering (no stripe-ok yet), while the one
        // before it may still be feeding: drop the former, keep the latter until the new one delivers.
        if (c.from !== null && c.from !== prev.oldParent) this.removeEdge(c.from, c.peer, c.stripe)
        from = prev.oldParent
      }
    }
    if (from !== null && (from === this.ctx.selfId || this.subscribers.has(from))) {
      // Make-before-break: keep the old parent feeding until the new one delivers.
      const oldParent = from
      const cancel = after(REMOVAL_TIMEOUT_MS, () => this.completeRemoval(c.peer, c.stripe, null))
      this.pendingRemovals.set(key, { oldParent, cancel })
    }
  }

  private completeRemoval(peer: string, stripe: number, deliveredBy: string | null): void {
    const key = `${peer}:${stripe}`
    const pr = this.pendingRemovals.get(key)
    if (!pr) return
    const current = this.topology.parents[peer]?.[stripe]
    if (deliveredBy !== null && deliveredBy !== current) return
    pr.cancel()
    this.pendingRemovals.delete(key)
    if (pr.oldParent !== current) this.removeEdge(pr.oldParent, peer, stripe)
  }

  private addEdge(parent: string, child: string, stripe: number): void {
    if (parent === this.ctx.selfId) this.ctx.relay.addChild(this.id, stripe, child)
    else this.send(parent, { t: 'add-child', ch: this.id, stripe, child })
  }

  private removeEdge(parent: string, child: string, stripe: number): void {
    if (parent === this.ctx.selfId) this.ctx.relay.removeChild(this.id, stripe, child)
    else if (this.subscribers.has(parent)) this.send(parent, { t: 'remove-child', ch: this.id, stripe, child })
  }

  private sendPositions(r: PlanResult): void {
    for (const sub of this.subscribers.values()) {
      if (!sub.active) continue
      const home = r.topology.home[sub.id] ?? null
      const depth = r.depth[sub.id] ?? []
      const sig = `${home}|${depth.join(',')}`
      if (this.lastPositions.get(sub.id) === sig) continue
      this.lastPositions.set(sub.id, sig)
      this.send(sub.id, { t: 'position', ch: this.id, home, depth })
    }
  }

  // --- topology reports --------------------------------------------------------------------------

  report(): TopologyReport {
    return {
      channel: this.id,
      publisher: this.ctx.selfId,
      k: this.k,
      m: this.m,
      topology: this.topology,
      depth: this.lastPlan?.depth ?? {},
      slots: this.lastPlan?.slots ?? {},
      rootSlots: this.ctx.rootSlots(this.id),
      overcommitted: this.lastPlan?.overcommitted ?? 0,
      changes: this.totalChanges,
      peers: [...this.subscribers.values()].map((s) => ({
        id: s.id,
        failures: s.failures,
        avoid: [...s.avoid.keys()],
        stats: s.stats,
        link: this.ctx.linkRate(s.id),
      })),
      publisherStats: this.ctx.publisherStats(),
    }
  }

  /** Sends the gzipped report to whoever has the Topology panel open (at most every 3 s). */
  private async sendTopology(to?: string): Promise<void> {
    const targets = to ? [to] : [...this.topoWatchers]
    if (!targets.length || this.stopped) return
    const z = toBase64Url(await gzip(JSON.stringify(this.report())))
    for (const id of targets) this.send(id, { t: 'topo', ch: this.id, z })
  }

  stop(): void {
    this.stopped = true
    this.timers.forEach((cancel) => cancel())
    this.replanTimer?.()
    this.reattachTimer?.()
    for (const pr of this.pendingRemovals.values()) pr.cancel()
    this.ctx.relay.dropChannel(this.id)
  }
}
