// Every peer runs the same PeerSession: a member of the full mesh, a relay for the channels it
// watches, and (with the right to publish) a publisher planning its own channels' trees.
//
// - Membership: the mesh (mesh/mesh.ts): links, gossip records, chat.
// - Publisher: PublishedStream + one ChannelPublisher per channel (session/publishedStream.ts, session/channelPublisher.ts).
// - Subscriber: one Subscription per watched channel (session/subscription.ts).
// - Publish rights: requests to publish and the owner's answers (session/publishRights.ts).
// - Relay: one RelayNode for every channel, forwarding over the mesh links' media channels.
// - Capacity: each connection's delivered rate (session/connMetrics.ts, capacity.ts), split into
//   relay slots per watched channel; the presenter's bitrate follows it (session/presenterRate.ts).
import type { PublishPolicy } from '../mesh/auth'
import { importPublicKey, type PeerIdentity } from '../mesh/identity'
import { gunzip } from '../mesh/envelope'
import { Mesh, type MeshOptions } from '../mesh/mesh'
import type { PeerConn } from '../mesh/meshConn'
import type { ChannelAnnouncement } from '../mesh/records'
import { fromBase64Url } from '../net/lobby'
import { Uplink } from '../net/uplink'
import { isTopologyReport, parsePeerMsg, type EncoderRates, type PeerMsg, type TopologyReport, type UplinkRates } from '../proto/messages'
import { verifyFragment } from '../proto/signing'
import { RelayNode } from '../relay/relayNode'
import { FROZEN_LAG_MS, rebalanceWeights, splitBudget, type CapacityModel } from './capacity'
import type { ChannelPublisher, PublisherContext } from './channelPublisher'
import { PublishedStream, type ShareOptions } from './publishedStream'
import { Subscription, type SubscriptionContext } from './subscription'
import { ChannelOwners } from './channelOwners'
import { AutoFallback, liveStreamsOf, planStage, type StageSource, type ViewQuality } from './stage'
import { HeadroomProbe } from './headroom'
import { PresenterRate, type RateStatus } from './presenterRate'
import { ConnMetrics, type LinkRow } from './connMetrics'
import { PublishRights, type PublishRequest, type PublishRightsContext, type RequestState } from './publishRights'
import { debounce, every, takeMainThreadLag } from '../net/ticker'
import type { Buffering } from '../media/jitterBuffer'

export interface PeerSessionOptions {
  joinCode: string
  identity: PeerIdentity
  ownerId: string
  name: string
  trackers?: string[]
  iceServers: RTCIceServer[]
  /** Debug upload cap (kbps): a token-bucket shaper, to emulate a constrained peer. */
  capKbps: number | null
  /** Debug: refuse mesh links with members of these names. */
  block?: string[]
  /** Connections per pair (media lanes, mesh/lanes.ts): 1..4, default 2; 1 = the mesh link only. */
  lanes?: number
  /** Tests: the mesh's connection, lane, rendezvous and storage factories (tests/fakes/network.ts). */
  meshDeps?: Pick<MeshOptions<PeerConn>, 'connect' | 'connectLane' | 'rendezvous' | 'storage'>
}

export interface LiveChannel {
  ann: ChannelAnnouncement
  publisher: string
}

export type { StageSource, ViewQuality } from './stage'
export type { PublishRequest, RequestState } from './publishRights'
export type { LinkRow } from './connMetrics'

/** Budget weights shift towards channels with a deficit this often. */
const REBALANCE_MS = 10_000
/** Headroom discovery (session/headroom.ts) runs this often while no media connection is backlogged... */
const HEADROOM_EVERY_MS = 30_000
/** ...or this often while the measured capacity holds the bitrate below the chosen quality. */
const HEADROOM_LIMITED_MS = 5000
/** ...and first this long after the first link opens. */
const HEADROOM_FIRST_MS = 1000
/** How often to consider running it. */
const HEADROOM_CHECK_MS = 1000
/** The encoder dropping this many frames per second means it can't keep up (shown, not acted on). */
const ENCODER_BEHIND_FPS = 3
/** Each connection's getStats() (path RTT, wire rates) is polled this often. */
const LINK_STATS_MS = 2000

/** Uplink stats (the capacity windows, and the bitrate that follows them) run this often. */
const UPLINK_SAMPLE_MS = 2000
const AUTO_BITRATE_CHECK_MS = 2000
const AUTO_QUALITY_CHECK_MS = 500
/** Debug/e2e: sample the stage source this often, keeping this many changes. */
const STAGE_LOG_MS = 100
const STAGE_LOG_MAX = 100

export class PeerSession implements PublisherContext, SubscriptionContext, PublishRightsContext {
  readonly mesh: Mesh
  readonly uplink: Uplink
  readonly relay: RelayNode
  /** Delivered-rate capacity per connection, per peer and of the uplink (session/capacity.ts). */
  readonly capacity: CapacityModel
  /** What this peer measures of its uplink and connections (session/connMetrics.ts). */
  readonly metrics: ConnMetrics
  readonly selfId: string
  readonly ownerId: string
  readonly signingKey: CryptoKey
  readonly capKbps: number | null
  publishing: PublishedStream | null = null
  /** Watched channels, by channel id. */
  readonly subs = new Map<number, Subscription>()
  /** The publisher whose stream is on the main stage. */
  selected: string | null = null
  /** Latest topology report per channel (Topology panel). */
  readonly topologyReports = new Map<number, TopologyReport>()
  /** Main player quality: Auto (full, falling back to the preview when it stalls), Full or Preview. */
  quality: ViewQuality = 'auto'
  /** Playback buffering for every stream this peer watches. */
  buffering: Buffering = 'auto'
  /** Auto quality is showing the preview because the full stream stalled. */
  autoFallback = false
  /** Publish rights: this member's request, the owner's pending ones and decisions (session/publishRights.ts). */
  readonly rights: PublishRights
  /** Set when the owner revoked this peer's stream. */
  revokedNotice = false
  /** Set when the owner removed this peer from the lobby. */
  kicked = false
  /** The presenter's bitrate control: what its stream should run at, and why (session/presenterRate.ts). */
  readonly rateControl: PresenterRate
  /** Budget weight per watched channel (deficit-driven). */
  readonly weights = new Map<number, number>()
  /** Debug/e2e: keep publishing after a revocation (relays must still drop the stream). */
  debugIgnoreRevocation = false
  /** Debug/e2e: stage source changes, newest last. */
  readonly stageLog: { at: number; source: StageSource; publisher: string | null }[] = []
  onChange: () => void = () => {}
  /** The owner granted this peer's request. */
  onGranted: () => void = () => {}

  private channels = new Map<number, LiveChannel>()
  private rootSlotsByChannel: Record<number, number> = {}
  private channelOwners = new ChannelOwners()
  private headroom: HeadroomProbe
  /** When the first mesh link opened (headroom discovery starts then), or null. */
  private firstLinkAt: number | null = null
  /** This peer's encoder (when presenting), per second over the last 2 s window. */
  encoderStatsNow: EncoderRates | null = null
  private reconcileSoon = debounce(() => this.reconcile())
  private timers: (() => void)[] = []
  /** Set by leave(): no more reconciles (they would re-create subscriptions). */
  private left = false
  private topoWatching = new Set<number>()
  /**
   * This computer can't keep up (last window, display only): the page stalled for `stallMs` (main
   * thread busy; such windows don't count towards capacity) or the encoder dropped frames.
   */
  localLoad: { stallMs: number; encoderDroppedFps: number } | null = null
  /** Auto quality's stall detector for the stage stream (session/stage.ts). */
  private autoStall = new AutoFallback()

  constructor(opts: PeerSessionOptions) {
    this.selfId = opts.identity.id
    this.ownerId = opts.ownerId
    this.signingKey = opts.identity.privateKey
    this.capKbps = opts.capKbps
    this.uplink = new Uplink(opts.capKbps)
    this.mesh = new Mesh({
      joinCode: opts.joinCode,
      identity: opts.identity,
      ownerId: opts.ownerId,
      name: opts.name,
      trackers: opts.trackers,
      iceServers: opts.iceServers,
      block: opts.block,
      lanes: opts.lanes,
      // The fakes implement PeerConn, not MeshConn: all the session relies on.
      ...(opts.meshDeps as Partial<MeshOptions>),
    })
    this.metrics = new ConnMetrics(this.mesh, this.uplink)
    this.capacity = this.metrics.capacity
    this.rateControl = new PresenterRate(this.selfId, this.capacity)
    // Stripes of one pair spread over its media lanes (each lane gets its own uplink queue).
    this.relay = new RelayNode(
      this.uplink,
      (id, index) => this.mesh.connFor(id, index),
      (id) => this.mesh.connectionsOf(id).map((c) => c.conn),
    )
    this.relay.verifier = (raw, ch) => this.verify(raw, ch)
    this.relay.onFragment = (frag, from) => this.subs.get(frag.header.channel >>> 0)?.onFragment(frag, from)
    this.headroom = new HeadroomProbe(this.uplink)
    this.rights = new PublishRights(this)

    const m = this.mesh
    m.onMedia = (data, from) => this.relay.receive(data, from)
    m.onBufferLow = () => this.uplink.kick()
    // Gossiped RTTs: the mesh link's path RTT from the getStats polling below.
    m.pathRttMs = (id) => this.metrics.pathRttMs(id)
    m.pathHeardAt = (id) => this.metrics.pathHeardAt(id)
    m.onApp = (raw, from) => {
      const msg = parsePeerMsg(raw)
      if (msg) this.handle(msg, from)
      else console.debug('dropped malformed message from', from)
    }
    m.onRecord = () => this.scheduleReconcile()
    m.onMemberJoin = () => this.scheduleReconcile()
    m.onMemberLeave = (id) => {
      this.rights.onMemberLeave(id)
      for (const c of this.ownChannels()) c.removeSubscriber(id)
      this.relay.removePeer(id)
      this.scheduleReconcile(0)
    }
    m.onAuth = () => this.onAuthChange()
    m.onLinkOpen = (id) => {
      this.firstLinkAt ??= performance.now()
      this.rights.onLinkOpen(id)
      // A publisher we watch is reachable again: make sure it still has us.
      for (const sub of this.subs.values()) if (sub.publisher === id) sub.subscribe()
      for (const ch of this.topoWatching) if (this.channels.get(ch)?.publisher === id) this.sendTo(id, { t: 'topo-req', ch, on: true })
    }
    m.onChange = () => this.onChange()
  }

  async start(): Promise<void> {
    await this.mesh.start()
    // Left while the mesh was starting: start no timers that leave() could no longer cancel.
    if (this.left) return
    this.timers.push(every(UPLINK_SAMPLE_MS, () => this.sampleUplink()))
    this.timers.push(every(HEADROOM_CHECK_MS, () => this.maybeDiscover()))
    this.timers.push(every(AUTO_QUALITY_CHECK_MS, () => this.checkAutoQuality()))
    this.timers.push(every(REBALANCE_MS, () => this.rebalance()))
    this.timers.push(every(AUTO_BITRATE_CHECK_MS, () => this.rateControl.checkAudience(this.publishing, performance.now())))
    this.timers.push(every(STAGE_LOG_MS, () => this.logStage()))
    this.timers.push(every(LINK_STATS_MS, () => void this.metrics.pollLinkStats()))
  }

  // --- channels ----------------------------------------------------------------------------------

  /** Whether a peer may publish: the owner, a granted key, or anyone under an open policy. */
  mayPublish(id: string): boolean {
    return this.rights.mayPublish(id)
  }

  get isOwner(): boolean {
    return this.rights.isOwner
  }

  get policy(): PublishPolicy {
    return this.rights.policy
  }

  get canShare(): boolean {
    return this.rights.canShare
  }

  private ownChannels(): ChannelPublisher[] {
    return this.publishing?.channels ?? []
  }

  /** Every announced channel of an authorized publisher, including this peer's own. */
  liveChannels(): LiveChannel[] {
    return [...this.channels.values()]
  }

  /** Publishers with a live full channel, oldest stream first. */
  liveStreams(): LiveChannel[] {
    return liveStreamsOf(this.liveChannels())
  }

  /** Channel ids stay bound to the publisher first seen claiming them (see channelOwners.ts). */
  private rebuildChannels(): void {
    const next = this.channelOwners.resolve({
      selfId: this.selfId,
      ownerId: this.ownerId,
      mayPublish: (id) => this.mayPublish(id),
      own: this.ownChannels().map((c) => c.announcement()),
      members: this.mesh.members(),
    })
    for (const ch of this.channels.keys()) {
      if (next.has(ch)) continue
      this.topologyReports.delete(ch)
      this.topoWatching.delete(ch)
    }
    this.channels = next
  }

  private scheduleReconcile(delay = 50): void {
    // After leave(): a reconcile would re-create subscriptions that nobody closes.
    if (!this.left) this.reconcileSoon.schedule(delay)
  }

  /** The preview channel of a publisher's stream, if announced. */
  previewOf(publisher: string): LiveChannel | undefined {
    return this.liveChannels().find((c) => c.publisher === publisher && c.ann.kind === 'preview')
  }

  /**
   * Picks the stage stream, and subscribes to exactly the channels this peer should watch: the
   * stage stream (full, or its preview), and every other stream's preview while two or more are
   * live (the tile rail). A presenter sees its own capture locally.
   */
  private reconcile(): void {
    if (this.left) return
    this.rebuildChannels()
    const plan = planStage({
      selfId: this.selfId,
      channels: this.liveChannels(),
      selected: this.selected,
      quality: this.quality,
      autoFallback: this.autoFallback,
    })
    this.selected = plan.selected
    this.autoFallback = plan.autoFallback
    const want = plan.want

    for (const [ch, sub] of this.subs) {
      if (!want.has(ch)) {
        sub.close()
        this.subs.delete(ch)
      }
    }
    for (const [ch, live] of want) {
      const sub = this.subs.get(ch)
      if (sub) sub.setAnnouncement(live.ann)
      else this.subs.set(ch, new Subscription(ch, live.publisher, live.ann, this))
    }
    this.updateOffers()
    this.onChange()
  }

  setBuffering(b: Buffering): void {
    this.buffering = b
    for (const sub of this.subs.values()) sub.player.clock.setBuffering(b)
    this.onChange()
  }

  setQuality(q: ViewQuality): void {
    this.quality = q
    this.autoFallback = false
    this.scheduleReconcile(0)
  }

  /** Auto quality: show the preview while the full stream stalls (session/stage.ts AutoFallback). */
  private checkAutoQuality(): void {
    if (this.quality !== 'auto') {
      this.autoStall.reset()
      return
    }
    const full = this.stageSub
    const next = this.autoStall.step(performance.now(), full, full?.player.stats.decodedFrames ?? 0, this.autoFallback)
    if (next === this.autoFallback) return
    this.autoFallback = next
    this.scheduleReconcile(0)
  }

  /** Where the stage picture comes from right now, and the player to draw (if remote). */
  stageView(): { source: StageSource; player: Subscription['player'] | null } {
    if (!this.selected) return { source: 'none', player: null }
    if (this.selected === this.selfId) return { source: this.publishing ? 'local' : 'none', player: null }
    const full = this.stageSub
    const prev = this.subFor(this.selected, 'preview')
    const prevReady = !!prev && prev.player.stats.decodedFrames > 0
    if (this.quality === 'preview' || (this.quality === 'auto' && this.autoFallback && prevReady)) {
      return prev ? { source: 'preview', player: prev.player } : { source: 'none', player: null }
    }
    // While switching, the preview fills in until the first full-resolution frame.
    if (full && full.player.stats.decodedFrames === 0 && prevReady) return { source: 'preview', player: prev!.player }
    return full ? { source: 'full', player: full.player } : { source: 'none', player: null }
  }

  private logStage(): void {
    const { source } = this.stageView()
    const last = this.stageLog.at(-1)
    if (last?.source === source && last.publisher === this.selected) return
    this.stageLog.push({ at: Date.now(), source, publisher: this.selected })
    if (this.stageLog.length > STAGE_LOG_MAX) this.stageLog.shift()
  }

  subFor(publisher: string, kind: 'full' | 'preview'): Subscription | null {
    for (const sub of this.subs.values()) if (sub.publisher === publisher && sub.ann.kind === kind) return sub
    return null
  }

  // --- publish rights ----------------------------------------------------------------------------

  /** This member's request to publish. */
  get requestState(): RequestState {
    return this.rights.requestState
  }

  /** Owner: pending publish requests. */
  get requests(): ReadonlyMap<string, PublishRequest> {
    return this.rights.requests
  }

  /** Asks the owner for the right to publish (or notes that it's already there). */
  requestPublish(): void {
    this.rights.requestPublish()
  }

  cancelRequest(): void {
    this.rights.cancelRequest()
  }

  /** Owner: answers a request (or all of them). */
  respond(id: string, answer: 'allow' | 'allow-all' | 'deny' | 'deny-all'): Promise<void> {
    return this.rights.respond(id, answer)
  }

  /** Owner: stops a member's stream and takes away its right to publish. */
  revokePublisher(id: string): Promise<void> {
    return this.rights.revokePublisher(id)
  }

  setPolicy(policy: PublishPolicy): Promise<void> {
    return this.rights.setPolicy(policy)
  }

  /** Owner: removes a member (members close their links, doors refuse it). */
  kick(id: string): Promise<void> {
    return this.rights.kick(id)
  }

  private onAuthChange(): void {
    if (!this.kicked && this.rights.banned) {
      this.kicked = true
      void this.leave()
      this.onChange()
      return
    }
    if (this.publishing && !this.canShare && !this.debugIgnoreRevocation) {
      this.stopSharing()
      this.revokedNotice = true
    }
    this.rights.onAuthChange()
    this.scheduleReconcile(0)
  }

  /** Puts a publisher's stream on the stage (its preview fills in until the full stream decodes). */
  select(publisher: string): void {
    this.selected = publisher
    this.autoFallback = false
    this.reconcile()
    this.logStage()
  }

  // --- sharing -----------------------------------------------------------------------------------

  async share(opts: ShareOptions): Promise<void> {
    if (!this.canShare) throw new Error('You need the owner’s permission to share.')
    this.revokedNotice = false
    this.stopSharing()
    this.rateControl.newStream()
    const stream = new PublishedStream(opts, this)
    stream.onEnded = () => {
      if (this.publishing === stream) this.stopSharing()
    }
    this.publishing = stream
    try {
      await stream.start()
    } catch (e) {
      if (this.publishing === stream) this.publishing = null
      stream.stop()
      throw e
    }
    // Stopped (or replaced by a newer share) while the capture prompt was open.
    if (this.publishing !== stream) return
    this.selected = this.selfId
    this.updateOffers()
    this.announce()
  }

  stopSharing(): void {
    const s = this.publishing
    if (!s) return
    this.publishing = null
    s.stop()
    this.announce()
  }

  get codec(): string | null {
    return this.publishing?.codec ?? null
  }

  // --- PublisherContext / SubscriptionContext ----------------------------------------------------

  rootSlots(channel: number): number {
    const c = this.ownChannels().find((x) => x.id === channel)
    return this.rootSlotsByChannel[channel] ?? c?.stripes ?? 1
  }

  announce(): void {
    this.mesh.updateRecord({ channels: this.ownChannels().map((c) => c.announcement()) })
    this.scheduleReconcile()
  }

  capacityKbps(): number | null {
    return this.capacity.uplinkKbps
  }

  uplinkSample(): { kbps: number; dropRate: number } {
    return this.metrics.uplinkNow
  }

  /** This peer's uplink, per second over the last 2 s window. */
  get uplinkStatsNow(): UplinkRates | null {
    return this.metrics.uplinkStatsNow
  }

  uplinkRates(): UplinkRates | null {
    return this.uplinkStatsNow
  }

  publisherStats(): { encoder: EncoderRates | null; uplink: UplinkRates | null } {
    return { encoder: this.encoderStatsNow, uplink: this.uplinkStatsNow }
  }

  /** Recomputes the budget split and gossips the offered slots if they changed. */
  private updateOffers(): void {
    const own = this.ownChannels().map((c) => ({ id: c.id, stripeKbps: c.stripeKbps, stripes: c.stripes }))
    const watched = [...this.subs.values()].map((s) => ({ id: s.channel, stripeKbps: s.ann.stripeKbps, weight: this.weights.get(s.channel) ?? 1 }))
    const split = splitBudget(this.capacity.uplinkKbps, own, watched)
    this.rootSlotsByChannel = split.rootSlots
    const offers = Object.fromEntries(Object.entries(split.offers).map(([ch, n]) => [String(ch), n]))
    const subs = [...this.subs.keys()]
    const rec = this.mesh.record
    const capacityKbps = this.capacity.uplinkKbps === null ? null : Math.round(this.capacity.uplinkKbps)
    if (
      JSON.stringify(offers) !== JSON.stringify(rec.offers) ||
      JSON.stringify(subs) !== JSON.stringify(rec.subs) ||
      capacityKbps !== rec.capacityKbps
    ) {
      this.mesh.updateRecord({ offers, subs, capacityKbps })
    }
  }

  /**
   * Shifts this peer's relay budget towards watched channels whose publisher reports a deficit
   * (it had to overcommit), away from those without. Converges in a few rounds, no negotiation.
   */
  private rebalance(): void {
    const weights: Record<string, number> = {}
    const deficits: Record<string, number> = {}
    for (const sub of this.subs.values()) {
      weights[sub.channel] = this.weights.get(sub.channel) ?? 1
      deficits[sub.channel] = sub.ann.deficit
    }
    const next = rebalanceWeights(weights, deficits)
    this.weights.clear()
    for (const [ch, w] of Object.entries(next)) this.weights.set(Number(ch), w)
    this.updateOffers()
  }

  /** The publisher's stream adapts its bitrate to what the audience can carry (Auto quality). */
  get autoBitrate(): boolean {
    return this.rateControl.autoBitrate
  }

  set autoBitrate(on: boolean) {
    this.rateControl.autoBitrate = on
  }

  /** The presenter's bitrate and what sets it, in numbers (presenter bar, Stats). Null when not presenting. */
  rateStatus(): RateStatus | null {
    return this.rateControl.status(this.publishing, this.metrics.stalledLanes())
  }

  // --- control messages --------------------------------------------------------------------------

  private sendTo(to: string, msg: PeerMsg): void {
    this.mesh.sendApp(to, msg)
  }

  private handle(msg: PeerMsg, from: string): void {
    switch (msg.t) {
      case 'publish-req':
      case 'publish-cancel':
      case 'publish-deny':
        this.rights.handle(msg, from)
        return
      case 'need-gop':
        // From a child on our trees (as a relay, or as the channel's publisher): the relay checks.
        this.relay.requestReplay(msg.ch >>> 0, msg.stripes, from)
        return
      case 'subscribe':
      case 'unsubscribe':
      case 'stripe-ok':
      case 'reattach':
      case 'need-key':
      case 'stats':
      case 'topo-req':
        this.ownChannels().find((c) => c.id === msg.ch >>> 0)?.handle(msg, from)
        return
      case 'set-parent':
      case 'add-child':
      case 'remove-child':
      case 'position': {
        // Tree commands for a channel come only from that channel's publisher.
        const sub = this.subs.get(msg.ch >>> 0)
        if (sub && sub.publisher === from) sub.handle(msg)
        return
      }
      case 'topo': {
        const ch = msg.ch >>> 0
        const live = this.channels.get(ch)
        if (!live || live.publisher !== from) return
        void gunzip(fromBase64Url(msg.z))
          .then((json) => {
            const report: unknown = JSON.parse(json)
            if (!isTopologyReport(report)) throw new Error('malformed report')
            this.topologyReports.set(ch, report)
            this.onChange()
          })
          // A corrupt, oversized or malformed report: keep the last good one.
          .catch((e) => console.debug('dropped topology report from', from, e))
        return
      }
      default: {
        const unhandled: never = msg
        return unhandled
      }
    }
  }

  /** Asks a channel's publisher for topology reports while the panel is open. */
  watchTopology(ch: number, on: boolean): void {
    ch >>>= 0
    const live = this.channels.get(ch)
    if (on) this.topoWatching.add(ch)
    else this.topoWatching.delete(ch)
    if (live && live.publisher !== this.selfId) this.sendTo(live.publisher, { t: 'topo-req', ch, on })
  }

  /** A fragment is accepted only if its channel's publisher may publish and signed it. */
  private async verify(raw: Uint8Array, ch: number): Promise<boolean> {
    const live = this.channels.get(ch)
    if (!live || !this.mayPublish(live.publisher)) return false
    const pubKey = this.mesh.store.get(live.publisher)?.env.k
    if (!pubKey) return false
    const key = await importPublicKey(pubKey)
    return !!key && verifyFragment(key, raw)
  }

  // --- capacity ----------------------------------------------------------------------------------

  private sampleUplink(): void {
    const now = performance.now()
    this.metrics.sampleUplink(now)
    this.encoderStatsNow = this.publishing?.sampleEncoder() ?? null
    const lagMs = Math.round(takeMainThreadLag())
    this.metrics.sampleLinks(now, lagMs)
    const encoderDroppedFps = this.encoderStatsNow?.droppedFps ?? 0
    this.localLoad = lagMs >= FROZEN_LAG_MS || encoderDroppedFps >= ENCODER_BEHIND_FPS ? { stallMs: lagMs, encoderDroppedFps } : null
    this.rateControl.adapt(this.publishing, now)
    this.updateOffers()
  }

  /**
   * Headroom discovery, the only probing: once shortly after the first link opens, then every 30 s
   * (5 s while a capacity estimate limits the bitrate) while no media connection is backlogged (a
   * backlogged one already shows what it carries).
   */
  private maybeDiscover(): void {
    if (this.headroom.running || this.firstLinkAt === null) return
    const now = performance.now()
    // Held below the chosen quality by a capacity estimate, with nothing backlogged to show it: the
    // estimate may be stale or low, and only a probe raises it.
    const limit = this.rateControl.target?.limit
    const limited = limit === 'uplink' || limit === 'viewers'
    const every = limited ? HEADROOM_LIMITED_MS : HEADROOM_EVERY_MS
    const due = this.headroom.lastAt === -Infinity ? now - this.firstLinkAt >= HEADROOM_FIRST_MS : now - this.headroom.lastAt >= every
    if (due && !this.metrics.backloggedNow) void this.discover()
  }

  /**
   * Pushes background bytes onto every open connection for 1.5 s (session/headroom.ts) and takes
   * what each delivered as a backlogged window. Returns the uplink's capacity afterwards, or null if
   * no probe ran.
   */
  async discover(): Promise<number | null> {
    if (!(await this.metrics.probe(this.headroom))) return null
    this.updateOffers()
    this.onChange()
    return this.capacity.uplinkKbps
  }

  /**
   * Per connection to `peer` (Peers panel, e2e): getStats() path stats and the live-media queueing
   * and drops of the last window.
   */
  linkStatsFor(peer: string): LinkRow[] {
    return this.metrics.linkStatsFor(peer)
  }

  /** This peer's live totals on the wire over the last poll (2 s). */
  liveRates(): { sendKbps: number | null; recvKbps: number | null } {
    return this.metrics.liveRates()
  }

  /** The link from this peer to `peer` over the last window, all its connections together (Topology). */
  linkRate(peer: string): { drops: number; queueMs: number; backlogged: boolean; capKbps: number | null } | null {
    return this.metrics.linkRate(peer)
  }

  /** What the connections to `peer` carry together (Peers panel), and whether they were its bottleneck. */
  peerCapacity(peer: string): { kbps: number | null; bound: boolean } {
    return this.capacity.peer(peer)
  }

  /** Path RTT inflation to `peer` over its baseline (display only: the Peers panel's "+N ms"). */
  pathQueueFor(peer: string): { inflationMs: number; queued: boolean } | null {
    return this.metrics.pathQueueFor(peer)
  }

  // --- debug / e2e -------------------------------------------------------------------------------

  /** The stage player (null while presenting or before anything is live). */
  get player(): Subscription['player'] | null {
    return this.stageView().player
  }

  /** When headroom discovery last ran (-Infinity before the first). */
  get lastProbeAt(): number {
    return this.headroom.lastAt
  }

  get stageSub(): Subscription | null {
    return this.selected ? this.subFor(this.selected, 'full') : null
  }

  debugViewer() {
    const sub = this.stageSub
    const p = sub?.player.stats
    return {
      id: this.selfId,
      state: sub ? 'connected' : this.mesh.joined ? 'idle' : 'joining',
      channel: sub?.channel ?? null,
      decoded: p?.decodedFrames ?? 0,
      dropped: p?.droppedFrames ?? 0,
      fps: p?.fps ?? 0,
      latencyMs: p?.latencyMs ?? null,
      bufferMs: p?.bufferMs ?? 0,
      homes: sub?.homes ?? [],
      parents: sub ? [...sub.parents] : [],
      children: sub ? this.relay.allChildren(sub.channel).size : 0,
      childIds: sub ? [...this.relay.allChildren(sub.channel)] : [],
      probeKbps: this.capacity.uplinkKbps,
      waitingForKeyframe: p?.waitingForKeyframe ?? true,
    }
  }

  debugPublisher() {
    const c = this.publishing?.full
    return {
      id: this.selfId,
      channel: c?.id ?? null,
      peers: c ? [...c.subscribers.values()].filter((s) => s.active).length : 0,
      hostChildren: c ? this.relay.allChildren(c.id).size : 0,
      overcommitted: c?.lastPlan?.overcommitted ?? 0,
      changes: c?.totalChanges ?? 0,
      rootSlots: c ? this.rootSlots(c.id) : 0,
      health: Object.fromEntries([...(c?.subscribers.values() ?? [])].map((s) => [s.id, { failures: s.failures, avoid: [...s.avoid.keys()] }])),
      topology: JSON.parse(JSON.stringify(c?.topology ?? { parents: {}, homes: {} })),
    }
  }

  async leave(): Promise<void> {
    // First, so nothing below (stopSharing announces) or after (mesh callbacks until its links
    // close) schedules a reconcile that would watch channels again.
    this.left = true
    this.reconcileSoon.cancel()
    this.timers.forEach((cancel) => cancel())
    this.timers = []
    this.stopSharing()
    for (const sub of this.subs.values()) sub.close()
    this.subs.clear()
    await this.mesh.leave()
  }
}
