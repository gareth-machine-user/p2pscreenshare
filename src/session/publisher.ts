// The publisher side of a peer: capture and encoding (PublishedStream), and for each channel the
// tree planner and its commands (ChannelPublisher). Each publisher plans its own channels' trees,
// so the planner fails together with the tree's source: no leader election, no handover.
import { AudioPipeline } from '../media/audio'
import { captureScreen, testPattern } from '../media/capture'
import { AudioMixer, captureMic } from '../media/mixer'
import { VideoPipeline } from '../media/encoder'
import { packetize, type EncodedFrame } from '../media/packetizer'
import type { Mesh } from '../mesh/mesh'
import type { ChannelAnnouncement } from '../mesh/records'
import { gzip } from '../mesh/envelope'
import { toBase64Url } from '../net/lobby'
import { signFrame } from '../proto/signing'
import type { EncoderRates, PublisherMsg, StreamInfo, SubscriberMsg, SubscriberStats, TopologyReport, UplinkRates } from '../proto/messages'
import { RateWindow, round1 } from './rates'
import type { RelayNode } from '../relay/relayNode'
import { emptyTopology, type ParentChange, type PlannerConfig, type PlannerPeer, type PlanResult, type Topology } from '../topology/model'
import { plan } from '../topology/planner'
import { feasibilityRatio, feasibleBitrate, MAX_FANOUT, stripeKbpsFor } from './capacity'
import { after, every } from '../net/ticker'
import { tuning } from '../tuning'

export interface ShareOptions {
  k: number
  m: number
  bitrateKbps: number
  source: 'screen' | 'test'
  /** Picker hint for screen capture. */
  surface?: 'monitor' | 'window' | 'browser'
  maxSize?: [number, number]
  /** Capture system/tab audio (or the test tone). */
  audio: boolean
  /** Mix in the microphone. */
  mic?: boolean
  /** Test pattern size, e.g. [1280, 720]. */
  testSize?: [number, number]
}

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
export const UPSTREAM_DISRUPTION_MS = 6000
/**
 * When a relay dies its whole subtree notices at about the same time. Reattach requests are
 * collected for this long and handled shallowest-first, so only the topmost complaint blames a
 * parent and the rest are recognized as collateral.
 */
export const REATTACH_BATCH_MS = 400
/** A parent that children report as silent must answer a ping within this time. */
const LIVENESS_TIMEOUT_MS = 1200
/** A peer that failed a liveness ping stays out of the plan this long (or until it answers again). */
const SUSPECT_HOLD_MS = 3000
const TOPOLOGY_REPORT_MS = 3000
/** A parent whose children's pieces arrive this much later than its own, for this long, loses them. */
export const LATE_PARENT_MS = 150
const LATE_PARENT_FOR_MS = 10_000
const LATE_PARENT_AVOID_MS = 30_000
/** Audience upload counts as short when supply is below 90% of demand for this long. */
const SHORT_SUPPLY_FOR_MS = 10_000
/** At most this often, an overcommitted channel asks its subscribers to re-measure their upload. */
const REPROBE_ASK_MS = 60_000

export interface ChannelSubscriber {
  id: string
  /** When it subscribed (newcomers stay leaves for a few seconds). */
  joinedAt: number
  stats: SubscriberStats | null
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
  private lastKeyRequest = 0
  private lastPositions = new Map<string, string>()
  /** `${peer}:${stripe}` -> until when that peer's feed is known to be broken upstream. */
  private disruptedUntil = new Map<string, number>()
  /** Frames are signed in order, so fragments leave in capture order. */
  private signing: Promise<void> = Promise.resolve()
  private reattachQueue: { child: string; stripe: number; linkOpen: boolean }[] = []
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
  /** Excess lateness (ms) per `${parent}:${stripe}`, from children's reports. */
  readonly lateness = new Map<string, number>()
  private lateSince = new Map<string, number>()
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
    this.timers.push(every(250, () => this.measureStripes()))
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
    if (this.stripeSamples.length > 40) this.stripeSamples.shift()
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
    const stripes = packetize(frame, this.k, this.m, this.id)
    stripes.forEach((frags, i) => {
      for (const raw of frags) this.stripeBytes[i] = (this.stripeBytes[i] ?? 0) + raw.byteLength
    })
    this.signing = this.signing
      .then(async () => {
        await signFrame(this.ctx.signingKey, stripes, frame.audio)
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
        break
      case 'stripe-ok':
        this.completeRemoval(from, msg.stripe, msg.parent)
        return
      case 'reattach':
        this.queueReattach(from, msg.stripe, msg.linkOpen)
        return
      case 'need-key': {
        const now = performance.now()
        if (now - this.lastKeyRequest > 300) {
          this.lastKeyRequest = now
          this.requestKeyframe()
        }
        return
      }
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
    this.reattachQueue.push({ child, stripe, linkOpen })
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
    const suspects = new Set<string>()
    for (const { child, stripe, linkOpen } of batch) {
      const sub = this.subscribers.get(child)
      if (!sub?.active) continue
      const parent = this.topology.parents[child]?.[stripe]
      // The parent is itself starved by an upstream failure that is already being handled:
      // keep this child where it is (the parent's feed will resume).
      if (linkOpen && parent && this.isDisrupted(parent, stripe)) continue
      // This child's feed is broken, and everything below it is going silent as well.
      this.markSubtreeDisrupted(child, stripe, true)
      if (parent && parent !== this.ctx.selfId) {
        // Link up but nothing forwarded: the parent is unreliable (rank it lower).
        // Link not up: this pair can't connect (avoid it for longer).
        // Either way, pick a different parent for this stripe.
        const pp = this.subscribers.get(parent)
        if (linkOpen && pp) {
          pp.failures++
          suspects.add(parent)
        }
        sub.avoid.set(parent, now + (linkOpen ? SILENT_PARENT_AVOID_MS : LINK_FAILED_AVOID_MS))
      }
      changed = true
    }
    if (changed) this.scheduleReplan(0)
    for (const p of suspects) void this.checkAlive(p)
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
    const kids = new Map<string, string[]>()
    for (const [peer, ps] of Object.entries(this.topology.parents)) {
      const par = ps[stripe]
      if (par) kids.set(par, [...(kids.get(par) ?? []), peer])
    }
    const until = performance.now() + UPSTREAM_DISRUPTION_MS
    const stack = includeRoot ? [root] : [...(kids.get(root) ?? [])]
    const seen = new Set<string>()
    while (stack.length) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      const key = `${n}:${stripe}`
      this.disruptedUntil.set(key, Math.max(this.disruptedUntil.get(key) ?? 0, until))
      stack.push(...(kids.get(n) ?? []))
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

  get plannerConfig(): PlannerConfig {
    const mesh = this.ctx.mesh
    return {
      hostId: this.ctx.selfId,
      k: this.k,
      m: this.m,
      rootSlots: this.ctx.rootSlots(this.id),
      maxFanout: MAX_FANOUT,
      minUptimeMsForRelay: 4000,
      switchGain: 1,
      rttSwitchMs: 40,
      rtt: (a, b) => mesh.member(a)?.rtt[b] ?? mesh.member(b)?.rtt[a] ?? null,
      lateness: (parent, stripe) => this.lateness.get(`${parent}:${stripe}`) ?? 0,
    }
  }

  /**
   * How much later a parent's children receive a stripe than the parent itself does, averaged over
   * its children. A parent late by more than LATE_PARENT_MS for 10 s loses its children there.
   */
  private updateLateness(now: number): void {
    const sums = new Map<string, { total: number; n: number }>()
    for (const sub of this.subscribers.values()) {
      if (!sub.active || !sub.stats) continue
      sub.stats.stripes.forEach((st, s) => {
        const p = st.parent
        if (!p || p === this.ctx.selfId) return
        const own = this.subscribers.get(p)?.stats?.stripes[s]?.lateMs ?? 0
        const key = `${p}:${s}`
        const acc = sums.get(key) ?? { total: 0, n: 0 }
        acc.total += Math.max(0, st.lateMs - own)
        acc.n++
        sums.set(key, acc)
      })
    }
    this.lateness.clear()
    for (const [key, { total, n }] of sums) this.lateness.set(key, total / n)
    for (const [key, late] of this.lateness) {
      if (late <= LATE_PARENT_MS) {
        this.lateSince.delete(key)
        continue
      }
      const since = this.lateSince.get(key) ?? now
      this.lateSince.set(key, since)
      if (now - since < LATE_PARENT_FOR_MS) continue
      // Consistently late: its children on this stripe move elsewhere for a while.
      this.lateSince.delete(key)
      const [parent, stripe] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))]
      for (const sub of this.subscribers.values()) {
        if (this.topology.parents[sub.id]?.[stripe] === parent) sub.avoid.set(parent, now + LATE_PARENT_AVOID_MS)
      }
    }
    for (const key of [...this.lateSince.keys()]) if (!this.lateness.has(key)) this.lateSince.delete(key)
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
    if (c.to !== null) this.addEdge(c.to, c.peer, c.stripe)
    this.send(c.peer, { t: 'set-parent', ch: this.id, stripe: c.stripe, parent: c.to })

    const prev = this.pendingRemovals.get(key)
    if (prev) {
      prev.cancel()
      this.pendingRemovals.delete(key)
      // The older pending parent is superseded too.
      if (prev.oldParent !== c.to) this.removeEdge(prev.oldParent, c.peer, c.stripe)
    }
    if (c.from !== null && (c.from === this.ctx.selfId || this.subscribers.has(c.from))) {
      // Make-before-break: keep the old parent feeding until the new one delivers.
      const oldParent = c.from
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
      peers: [...this.subscribers.values()].map((s) => ({ id: s.id, failures: s.failures, avoid: [...s.avoid.keys()], stats: s.stats })),
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

/** Draws a random u32 channel id. */
export function newChannelId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

/** The low-resolution preview channel every stream also publishes (tiles, weak downlinks). */
export const PREVIEW = { width: 320, height: 180, fps: 5, kbps: 120 }

/**
 * A shared screen: one capture, encoded once per channel. The full-resolution channel carries the
 * audio; the preview channel gets a downscaled copy of every 5th-of-a-second frame.
 */
export class PublishedStream {
  localStream: MediaStream | null = null
  readonly channels: ChannelPublisher[] = []
  /** What audio the stream carries (the browser may give no system audio, e.g. for windows). */
  audio = { system: false, mic: false, systemMuted: false, micMuted: false }
  private video: VideoPipeline | null = null
  private preview: VideoPipeline | null = null
  private audioPipe: AudioPipeline | null = null
  private mixer: AudioMixer | null = null
  private micTrack: MediaStreamTrack | null = null
  private stopSource: (() => void) | null = null
  private lastPreviewAt = -Infinity
  private previewCanvas: OffscreenCanvas | null = null
  private previewBusy = false

  constructor(
    readonly opts: ShareOptions,
    private ctx: PublisherContext,
  ) {
    this.ceilingKbps = opts.bitrateKbps
  }

  get full(): ChannelPublisher | undefined {
    return this.channels.find((c) => c.kind === 'full')
  }

  get previewChannel(): ChannelPublisher | undefined {
    return this.channels.find((c) => c.kind === 'preview')
  }

  get codec(): string | null {
    return this.video?.codec ?? null
  }

  async start(): Promise<void> {
    const o = this.opts
    let stream: MediaStream
    if (o.source === 'test') {
      const [w, h] = o.testSize ?? [1280, 720]
      const tp = testPattern(w, h, 30, o.audio)
      stream = tp.stream
      this.stopSource = tp.stop
    } else {
      stream = await captureScreen({ surface: o.surface, audio: o.audio, maxWidth: o.maxSize?.[0], maxHeight: o.maxSize?.[1] })
      this.stopSource = () => stream.getTracks().forEach((t) => t.stop())
    }
    this.localStream = stream

    // System/tab audio and the microphone are mixed into one track.
    const systemTrack = o.audio ? (stream.getAudioTracks()[0] ?? null) : null
    this.micTrack = o.mic ? await captureMic() : null
    const canEncodeAudio = AudioPipeline.supported()
    if (canEncodeAudio && (systemTrack || this.micTrack)) this.mixer = new AudioMixer(systemTrack, this.micTrack)
    this.audio = { system: !!systemTrack, mic: !!this.micTrack, systemMuted: false, micMuted: false }
    const withAudio = !!this.mixer

    const full = new ChannelPublisher(newChannelId(), 'full', o.k, o.m, o.bitrateKbps, withAudio, this.ctx, () => this.video?.requestKeyframe())
    const preview = new ChannelPublisher(newChannelId(), 'preview', 1, 0, PREVIEW.kbps, false, this.ctx, () => this.preview?.requestKeyframe())
    this.channels.push(full, preview)

    const vt = stream.getVideoTracks()[0]
    this.video = new VideoPipeline(vt, { bitrateKbps: o.bitrateKbps, fps: 30, keyframeIntervalMs: tuning.keyframeIntervalMs })
    this.video.onFrame = (f) => full.emit(f)
    this.video.onStreamInfo = (info) => full.setStream({ ...info, audio: this.audioPipe?.info ?? undefined })
    this.video.onRawFrame = (frame) => this.feedPreview(frame)
    void this.video.start()

    this.preview = new VideoPipeline(null, { bitrateKbps: PREVIEW.kbps, fps: PREVIEW.fps, keyframeIntervalMs: tuning.keyframeIntervalMs })
    this.preview.onFrame = (f) => preview.emit(f)
    this.preview.onStreamInfo = (info) => preview.setStream(info)

    if (this.mixer) {
      this.audioPipe = new AudioPipeline(this.mixer.track)
      this.audioPipe.onFrame = (f) => {
        // The decoder config learns about audio once the encoder is configured.
        if (full.stream && !full.stream.audio && this.audioPipe?.info) full.setStream({ ...full.stream, audio: this.audioPipe.info })
        full.emit(f)
      }
      this.audioPipe.start().catch((e) => console.warn('audio disabled', e))
    }
    // Ending the capture from the browser's own "Stop sharing" bar ends the stream too.
    vt.addEventListener('ended', () => this.onEnded())
    this.ctx.announce()
  }

  /** Downscales a captured frame for the preview channel, at most PREVIEW.fps times a second. */
  private feedPreview(frame: VideoFrame): void {
    const now = performance.now()
    if (!this.preview || this.previewBusy || now - this.lastPreviewAt < 1000 / PREVIEW.fps) return
    this.lastPreviewAt = now
    const scale = Math.min(PREVIEW.width / frame.displayWidth, PREVIEW.height / frame.displayHeight, 1)
    const w = Math.max(2, Math.round((frame.displayWidth * scale) / 2) * 2)
    const h = Math.max(2, Math.round((frame.displayHeight * scale) / 2) * 2)
    if (!this.previewCanvas || this.previewCanvas.width !== w || this.previewCanvas.height !== h) this.previewCanvas = new OffscreenCanvas(w, h)
    const g = this.previewCanvas.getContext('2d')!
    g.drawImage(frame, 0, 0, w, h)
    const small = new VideoFrame(this.previewCanvas, { timestamp: frame.timestamp })
    this.previewBusy = true
    void this.preview.encodeExternal(small).finally(() => (this.previewBusy = false))
  }

  /**
   * Changes bitrate (and the capture size cap) in place: the encoder reconfigures and sends a
   * keyframe, with no new capture (which would need the user to pick a screen again) and no new
   * channel.
   */
  async setQuality(bitrateKbps: number, maxSize?: [number, number]): Promise<void> {
    const full = this.full
    if (!full || !this.video) return
    this.ceilingKbps = bitrateKbps
    full.kbps = bitrateKbps
    ;(this.opts as { bitrateKbps: number }).bitrateKbps = bitrateKbps
    this.video.setBitrate(bitrateKbps)
    const track = this.localStream?.getVideoTracks()[0]
    if (maxSize && track && this.opts.source !== 'test') {
      await track.applyConstraints({ width: { max: maxSize[0] }, height: { max: maxSize[1] }, frameRate: { ideal: 30, max: 30 } }).catch(() => {})
      ;(this.opts as { maxSize?: [number, number] }).maxSize = maxSize
    }
    full.limited = null
    this.ctx.announce()
  }

  /** The most the bitrate may go up to: the quality the presenter chose. */
  ceilingKbps: number

  /** Adapts the encoder's bitrate (congestion control) without changing the chosen quality. */
  adaptBitrate(kbps: number): void {
    const full = this.full
    if (!full || !this.video) return
    const next = Math.round(Math.min(this.ceilingKbps, Math.max(300, kbps)) / 50) * 50
    if (next === full.kbps) return
    full.kbps = next
    this.video.setBitrate(next)
    this.ctx.announce()
  }

  private encoderWindow = new RateWindow<{ captured: number; encoded: number; dropped: number; keyframes: number; bytes: number }>()

  /** The full channel's encoder over the window since the previous call. */
  sampleEncoder(): EncoderRates | null {
    const v = this.video
    if (!v) return null
    const r = this.encoderWindow.sample({
      captured: v.framesIn,
      encoded: v.framesEncoded,
      dropped: v.framesDropped,
      keyframes: v.keyframes,
      bytes: v.bytesOut,
    })
    return {
      codec: v.codec,
      targetKbps: this.full?.kbps ?? this.opts.bitrateKbps,
      ceilingKbps: this.ceilingKbps,
      kbps: Math.round((r.bytes * 8) / 1000),
      captureFps: round1(r.captured),
      encodedFps: round1(r.encoded),
      droppedFps: round1(r.dropped),
      keyframes: round1(r.keyframes),
      encodeMs: round1(v.encodeMs),
      maxFrameKB: round1(v.takeMaxFrameBytes() / 1024),
    }
  }

  setSystemMuted(muted: boolean): void {
    this.mixer?.setSystemMuted(muted)
    this.audio = { ...this.audio, systemMuted: muted }
  }

  setMicMuted(muted: boolean): void {
    this.mixer?.setMicMuted(muted)
    this.audio = { ...this.audio, micMuted: muted }
  }

  onEnded: () => void = () => {}

  stop(): void {
    this.video?.stop()
    this.preview?.stop()
    this.audioPipe?.stop()
    this.mixer?.close()
    this.micTrack?.stop()
    this.stopSource?.()
    for (const c of this.channels) c.stop()
    this.channels.length = 0
    this.ctx.announce()
  }
}
