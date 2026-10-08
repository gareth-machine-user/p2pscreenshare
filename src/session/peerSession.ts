// Every peer runs the same PeerSession: a member of the full mesh, a relay for the channels it
// watches, and (with the right to publish) a publisher planning its own channels' trees.
//
// - Membership: the mesh (mesh/mesh.ts): links, gossip records, chat.
// - Publisher: PublishedStream + one ChannelPublisher per channel (session/publishedStream.ts, session/channelPublisher.ts).
// - Subscriber: one Subscription per watched channel (session/subscription.ts).
// - Relay: one RelayNode for every channel, forwarding over the mesh links' media channels.
// - Capacity: each connection's delivered rate (session/capacity.ts), split into relay slots per
//   watched channel; the presenter's bitrate follows it (session/congestion.ts).
import { ban, grant, isBanned, mayPublish as mayPublishDoc, revoke, setPolicy, type PublishPolicy } from '../mesh/auth'
import { importPublicKey, type PeerIdentity } from '../mesh/identity'
import { gunzip } from '../mesh/envelope'
import { Mesh, type MeshOptions } from '../mesh/mesh'
import type { PeerConn } from '../mesh/meshConn'
import type { ChannelAnnouncement } from '../mesh/records'
import { fromBase64Url } from '../net/lobby'
import { Uplink } from '../net/uplink'
import type { PairConn } from '../mesh/dataConn'
import { LinkStatsTracker, parseLinkStats, pathInflation } from '../net/linkStats'
import { isTopologyReport, parsePeerMsg, type EncoderRates, type PeerMsg, type TopologyReport, type UplinkRates } from '../proto/messages'
import { RateWindow, round1 } from './rates'
import { verifyFragment } from '../proto/signing'
import { RelayNode } from '../relay/relayNode'
import { CapacityModel, FROZEN_LAG_MS, linkWindow, rebalanceWeights, splitBudget, stripeKbpsFor, type ConnWindow, type LinkSnap } from './capacity'
import { AudienceCap, audienceLimit, BitrateController, rateTarget, type RateTarget } from './congestion'
import type { ChannelPublisher, PublisherContext } from './channelPublisher'
import { PublishedStream, type ShareOptions } from './publishedStream'
import { Subscription, type SubscriptionContext } from './subscription'
import { ChannelOwners } from './channelOwners'
import { AutoFallback, liveStreamsOf, planStage, type StageSource, type ViewQuality } from './stage'
import { HeadroomProbe } from './headroom'
import { after, every, takeMainThreadLag } from '../net/ticker'
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

/** One connection to a peer, as the Peers panel shows it (PeerSession.linkStatsFor). */
export interface LinkRow {
  /** 0: the mesh link; 1..: media lanes. */
  lane: number
  /** Wire send rate (getStats bytesSent: all channels, with overhead). */
  sendKbps: number | null
  /** Wire receive rate (getStats bytesReceived). */
  recvKbps: number | null
  /** Live media handed to this connection over the last window. */
  mediaKbps: number | null
  /** What it delivered over the last window (all its channels), and what it can carry (capacity.ts). */
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
  /** The connection stalled recently (its send buffer stopped draining; net/uplink.ts STALL_MS). */
  stalled: boolean
  relayed: boolean | null
  /** SCTP congestion window (bytes), if the browser exposes sctp-transport stats (Chrome doesn't). */
  cwnd: number | null
}

export interface LiveChannel {
  ann: ChannelAnnouncement
  publisher: string
}

export type { StageSource, ViewQuality } from './stage'
/** A member's request to publish, as the requester sees it. */
export type RequestState = 'idle' | 'waiting' | 'owner-away' | 'denied' | 'granted'

export interface PublishRequest {
  id: string
  at: number
}

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
/** Path RTT inflation shown as "+N ms" in the Peers panel, at least (display only). */
const RTT_QUEUE_SHOWN_MS = 40
/** Each connection's getStats() (path RTT, wire rates) is polled this often. */
const LINK_STATS_MS = 2000

/** Uplink stats (the capacity windows, and the bitrate that follows them) run this often. */
const UPLINK_SAMPLE_MS = 2000
const AUTO_BITRATE_CHECK_MS = 2000
const AUTO_QUALITY_CHECK_MS = 500
/** Debug/e2e: sample the stage source this often, keeping this many changes. */
const STAGE_LOG_MS = 100
const STAGE_LOG_MAX = 100

/** One connection's figures over the last window (Peers panel, Topology). */
/** One connection's last capacity window (session/capacity.ts linkWindow), rounded for display. */
interface LaneRate {
  mediaKbps: number
  deliveredKbps: number
  drops: number
  queueMs: number
  backlogged: boolean
  stalled: boolean
}

/** What the session keeps per open connection (a mesh link or a lane), in one place. */
interface ConnRecord {
  peer: string
  lane: number
  /** Its getStats() history (net/linkStats.ts): path RTT, wire rates. */
  tracker: LinkStatsTracker
  /** The snapshot the last capacity window ended with, and that window's figures. */
  last: LinkSnap | null
  rate: LaneRate | null
}

export class PeerSession implements PublisherContext, SubscriptionContext {
  readonly mesh: Mesh
  readonly uplink: Uplink
  readonly relay: RelayNode
  /** Delivered-rate capacity per connection, per peer and of the uplink (session/capacity.ts). */
  readonly capacity = new CapacityModel()
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
  /** This member's request to publish. */
  requestState: RequestState = 'idle'
  /** Owner: pending publish requests. */
  readonly requests = new Map<string, PublishRequest>()
  /** Set when the owner revoked this peer's stream. */
  revokedNotice = false
  /** Set when the owner removed this peer from the lobby. */
  kicked = false
  /** The publisher's stream adapts its bitrate to what the audience can carry (Auto quality). */
  autoBitrate = false
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
  /** Some media connection was backlogged in the last window (no headroom probe then). */
  private backloggedNow = false
  private uplinkSampleAt = { at: performance.now(), sent: 0, sentItems: 0, dropped: 0 }
  private uplinkNow = { kbps: 0, dropRate: 0 }
  /** This peer's uplink and (when presenting) encoder, per second over the last 2 s window. */
  uplinkStatsNow: UplinkRates | null = null
  encoderStatsNow: EncoderRates | null = null
  private uplinkWindow = new RateWindow<{ bytes: number; t0: number; t1: number; t2: number; stalls: number }>()
  private lastQueueDelay = { sum: 0, n: 0 }
  private reconcileTimer: (() => void) | null = null
  private timers: (() => void)[] = []
  /** Set by leave(): no more reconciles (they would re-create subscriptions). */
  private left = false
  private topoWatching = new Set<number>()
  private rateCtl = new BitrateController()
  /** The bitrate the presenter's stream should run at, and what limits it (session/congestion.ts). */
  rate: RateTarget | null = null
  /**
   * This computer can't keep up (last window, display only): the page stalled for `stallMs` (main
   * thread busy; such windows don't count towards capacity) or the encoder dropped frames.
   */
  localLoad: { stallMs: number; encoderDroppedFps: number } | null = null
  /** Per open connection (mesh link or lane), refreshed by openConns(). */
  private connRecs = new Map<PairConn, ConnRecord>()
  private pollingStats = false
  /** Auto quality's cap for the presenter's stream, apart from the chosen quality (session/congestion.ts). */
  private audienceCap = new AudienceCap()
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
    // Stripes of one pair spread over its media lanes (each lane gets its own uplink queue).
    this.relay = new RelayNode(
      this.uplink,
      (id, index) => this.mesh.connFor(id, index),
      (id) => this.mesh.connectionsOf(id).map((c) => c.conn),
    )
    this.relay.verifier = (raw, ch) => this.verify(raw, ch)
    this.relay.onFragment = (frag, from) => this.subs.get(frag.header.channel >>> 0)?.onFragment(frag, from)
    this.headroom = new HeadroomProbe(this.uplink)

    const m = this.mesh
    m.onMedia = (data, from) => this.relay.receive(data, from)
    m.onBufferLow = () => this.uplink.kick()
    // Gossiped RTTs: the mesh link's path RTT from the getStats polling below.
    m.pathRttMs = (id) => {
      for (const r of this.connRecs.values()) if (r.peer === id && r.lane === 0) return r.tracker.current(performance.now())?.rttMs ?? null
      return null
    }
    m.onApp = (raw, from) => {
      const msg = parsePeerMsg(raw)
      if (msg) this.handle(msg, from)
      else console.debug('dropped malformed message from', from)
    }
    m.onRecord = () => this.scheduleReconcile()
    m.onMemberJoin = () => this.scheduleReconcile()
    m.onMemberLeave = (id) => {
      this.requests.delete(id)
      if (id === this.ownerId && this.requestState === 'waiting') this.requestState = 'owner-away'
      for (const c of this.ownChannels()) c.removeSubscriber(id)
      this.relay.removePeer(id)
      this.scheduleReconcile(0)
    }
    m.onAuth = () => this.onAuthChange()
    m.onLinkOpen = (id) => {
      this.firstLinkAt ??= performance.now()
      if (id === this.ownerId && this.requestState === 'owner-away') this.requestPublish()
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
    this.timers.push(every(AUTO_BITRATE_CHECK_MS, () => this.checkAutoBitrate()))
    this.timers.push(every(STAGE_LOG_MS, () => this.logStage()))
    this.timers.push(every(LINK_STATS_MS, () => void this.pollLinkStats()))
  }

  // --- channels ----------------------------------------------------------------------------------

  /** Whether a peer may publish: the owner, a granted key, or anyone under an open policy. */
  mayPublish(id: string): boolean {
    return mayPublishDoc(this.mesh.auth, this.mesh.pubKeyOf(id), id === this.ownerId)
  }

  get isOwner(): boolean {
    return this.selfId === this.ownerId
  }

  get policy(): PublishPolicy {
    return this.mesh.auth.policy
  }

  get canShare(): boolean {
    return this.mayPublish(this.selfId)
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
    for (const ch of this.channels.keys()) if (!next.has(ch)) this.topologyReports.delete(ch)
    this.channels = next
  }

  private scheduleReconcile(delay = 50): void {
    // After leave(): a reconcile would re-create subscriptions that nobody closes.
    if (this.left) return
    if (this.reconcileTimer !== null) {
      if (delay > 0) return
      this.reconcileTimer()
    }
    this.reconcileTimer = after(delay, () => {
      this.reconcileTimer = null
      this.reconcile()
    })
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

  /** Asks the owner for the right to publish (or notes that it's already there). */
  requestPublish(): void {
    if (this.canShare) {
      this.requestState = 'granted'
      this.onGranted()
    } else if (!this.mesh.linkFor(this.ownerId)) {
      this.requestState = 'owner-away'
    } else {
      this.requestState = 'waiting'
      this.sendTo(this.ownerId, { t: 'publish-req' })
    }
    this.onChange()
  }

  cancelRequest(): void {
    // Withdrawn at the owner too, or it could still allow a request nobody is waiting on.
    if (this.requestState === 'waiting') this.sendTo(this.ownerId, { t: 'publish-cancel' })
    this.requestState = 'idle'
    this.onChange()
  }

  /** Owner: answers a request (or all of them). */
  async respond(id: string, answer: 'allow' | 'allow-all' | 'deny' | 'deny-all'): Promise<void> {
    if (!this.isOwner) return
    const pending = answer.endsWith('-all') ? [...this.requests.keys()] : [id]
    for (const p of pending) this.requests.delete(p)
    if (answer === 'allow' || answer === 'allow-all') {
      await this.mesh.updateAuth((doc) => {
        let d = answer === 'allow-all' ? setPolicy(doc, 'open') : doc
        for (const p of pending) {
          const key = this.mesh.pubKeyOf(p)
          if (key) d = grant(d, key)
        }
        return d
      })
    } else {
      if (answer === 'deny-all') await this.mesh.updateAuth((doc) => setPolicy(doc, 'closed'))
      for (const p of pending) this.sendTo(p, { t: 'publish-deny' })
    }
    this.onChange()
  }

  /** Owner: stops a member's stream and takes away its right to publish. */
  async revokePublisher(id: string): Promise<void> {
    const key = this.mesh.pubKeyOf(id)
    if (!this.isOwner || !key || id === this.ownerId) return
    await this.mesh.updateAuth((doc) => revoke(doc, key))
  }

  async setPolicy(policy: PublishPolicy): Promise<void> {
    if (!this.isOwner) return
    // 'deny-all' and 'allow-all' set the policy in the same auth update that answers the pending
    // requests: one version, one gossip round.
    if (policy === 'closed') await this.respond('', 'deny-all')
    else if (policy === 'open') await this.respond('', 'allow-all')
    else await this.mesh.updateAuth((doc) => setPolicy(doc, policy))
  }

  private onAuthChange(): void {
    if (!this.kicked && isBanned(this.mesh.auth, this.mesh.pubKeyOf(this.selfId))) {
      this.kicked = true
      void this.leave()
      this.onChange()
      return
    }
    if (this.publishing && !this.canShare && !this.debugIgnoreRevocation) {
      this.stopSharing()
      this.revokedNotice = true
    }
    if (this.requestState === 'waiting' && this.canShare) {
      this.requestState = 'granted'
      this.onGranted()
    }
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
    this.audienceCap = new AudienceCap()
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
    return this.uplinkNow
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

  /**
   * Auto quality for a presenter: when the audience's upload can't carry the stream for 10 s, the
   * publisher's sharing controls warn, and with Auto quality the bitrate is capped at what it can
   * carry (adaptBitrate applies it). The chosen quality stays the ceiling, so the cap lifts once
   * the audience carries the stream again.
   */
  private checkAutoBitrate(): void {
    const full = this.publishing?.full
    if (!this.publishing || !full) return
    this.audienceCap.step(performance.now(), this.autoBitrate, full.limited, this.publishing.ceilingKbps)
  }

  /**
   * The presenter's bitrate (session/congestion.ts): 85% of what the wire budget per direct child
   * carries, the budget being the smaller of the uplink's capacity shared by the direct children
   * and the median capacity of the peers it feeds directly. Runs on each 2 s window.
   */
  private adaptBitrate(now: number): void {
    const s = this.publishing
    const full = s?.full
    if (!s || !full) {
      this.rate = null
      return
    }
    const edges = this.directEdges(full)
    const stripes = full.stripes
    const peerKbps = [...edges.byPeer].map(([peer, e]) => {
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
    this.rate = t
    const next = this.rateCtl.step(now, full.kbps, t)
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

  /**
   * The presenter's bitrate and what sets it, in numbers (presenter bar, Stats). Null when not
   * presenting.
   */
  rateStatus(): {
    currentKbps: number
    chosenKbps: number
    limit: RateTarget['limit']
    targetKbps: number
    uplinkKbps: number | null
    medianPeerKbps: number | null
    feasibleKbps: number | null
    stalledLanes: number
  } | null {
    const s = this.publishing
    const full = s?.full
    if (!s || !full) return null
    const t = this.rate
    return {
      currentKbps: full.kbps,
      chosenKbps: s.ceilingKbps,
      limit: t?.limit ?? 'chosen',
      targetKbps: Math.round(t?.kbps ?? s.ceilingKbps),
      uplinkKbps: this.capacity.uplinkKbps === null ? null : Math.round(this.capacity.uplinkKbps),
      medianPeerKbps: t?.medianPeerKbps == null ? null : Math.round(t.medianPeerKbps),
      feasibleKbps: full.limited?.feasibleKbps ?? null,
      stalledLanes: [...this.connRecs.values()].filter((r) => r.rate?.stalled).length,
    }
  }

  /** Owner: removes a member (members close their links, doors refuse it). */
  async kick(id: string): Promise<void> {
    const key = this.mesh.pubKeyOf(id)
    if (!this.isOwner || !key || id === this.ownerId) return
    await this.mesh.updateAuth((doc) => ban(doc, key))
  }

  // --- control messages --------------------------------------------------------------------------

  private sendTo(to: string, msg: PeerMsg): void {
    this.mesh.sendApp(to, msg)
  }

  private handle(msg: PeerMsg, from: string): void {
    switch (msg.t) {
      case 'publish-req':
        if (!this.isOwner || this.mayPublish(from)) return
        if (this.policy === 'closed') this.sendTo(from, { t: 'publish-deny' })
        else if (this.policy === 'open') void this.respond(from, 'allow')
        else this.requests.set(from, { id: from, at: Date.now() })
        this.onChange()
        return
      case 'publish-cancel':
        if (this.isOwner && this.requests.delete(from)) this.onChange()
        return
      case 'publish-deny':
        if (from === this.ownerId && this.requestState === 'waiting') this.requestState = 'denied'
        this.onChange()
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
    const live = this.channels.get(ch >>> 0)
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
    const s = this.uplink.stats
    const last = this.uplinkSampleAt
    const dt = (now - last.at) / 1000
    if (dt <= 0) return
    const items = s.sentItems - last.sentItems
    const dropped = s.droppedItems - last.dropped
    this.uplinkNow = {
      kbps: ((s.sentBytes - last.sent) * 8) / 1000 / dt,
      dropRate: items + dropped > 0 ? dropped / (items + dropped) : 0,
    }
    this.uplinkSampleAt = { at: now, sent: s.sentBytes, sentItems: s.sentItems, dropped: s.droppedItems }
    const r = this.uplinkWindow.sample({ bytes: s.sentBytes, t0: s.droppedByLayer[0], t1: s.droppedByLayer[1], t2: s.droppedByLayer[2] + s.droppedByLayer[3], stalls: s.bufferStalls })
    const dSum = s.queueDelaySum - this.lastQueueDelay.sum
    const dN = s.queueDelayN - this.lastQueueDelay.n
    this.lastQueueDelay = { sum: s.queueDelaySum, n: s.queueDelayN }
    this.uplinkStatsNow = {
      kbps: Math.round((r.bytes * 8) / 1000),
      drops: [round1(r.t0), round1(r.t1), round1(r.t2)],
      stalls: round1(r.stalls),
      queueMs: dN > 0 ? Math.round(dSum / dN) : 0,
    }
    this.encoderStatsNow = this.publishing?.sampleEncoder() ?? null
    const lagMs = Math.round(takeMainThreadLag())
    this.sampleLinks(now, lagMs)
    this.adaptBitrate(now)
    this.updateOffers()
  }

  /**
   * Every open connection (the mesh link and lanes of each peer) with its record. Records of
   * connections that are no longer open are dropped here, so this is the one place they are pruned.
   */
  private openConns(): [PairConn, ConnRecord][] {
    const out: [PairConn, ConnRecord][] = []
    const seen = new Set<PairConn>()
    for (const peer of [...this.mesh.conns.keys()]) {
      for (const { lane, conn } of this.mesh.connectionsOf(peer)) {
        if (!conn.isOpen) continue
        seen.add(conn)
        let r = this.connRecs.get(conn)
        if (!r) this.connRecs.set(conn, (r = { peer, lane, tracker: new LinkStatsTracker(), last: null, rate: null }))
        out.push([conn, r])
      }
    }
    for (const conn of this.connRecs.keys()) if (!seen.has(conn)) this.connRecs.delete(conn)
    this.capacity.retain(seen)
    return out
  }

  /**
   * One capacity window (session/capacity.ts): what each connection delivered since the last one,
   * whether it was backlogged or stalled meanwhile. A window in which the page froze (the main
   * thread lagged FROZEN_LAG_MS or more) says nothing about the network and is left out.
   */
  private sampleLinks(now: number, lagMs: number): void {
    const windows: ConnWindow[] = []
    for (const [conn, rec] of this.openConns()) {
      const snap = this.uplink.snapshot(conn, conn.probeLink, now)
      const last = rec.last
      rec.last = snap
      rec.rate = null
      // A connection's counters restart if the uplink forgot it (closed and reopened).
      if (!last || snap.handed < last.handed || snap.items < last.items) continue
      const w = linkWindow(conn, rec.peer, last, snap)
      windows.push(w)
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
    const encoderDroppedFps = this.encoderStatsNow?.droppedFps ?? 0
    this.localLoad = lagMs >= FROZEN_LAG_MS || encoderDroppedFps >= ENCODER_BEHIND_FPS ? { stallMs: lagMs, encoderDroppedFps } : null
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
    const limited = this.rate !== null && (this.rate.limit === 'uplink' || this.rate.limit === 'viewers')
    const every = limited ? HEADROOM_LIMITED_MS : HEADROOM_EVERY_MS
    const due = this.headroom.lastAt === -Infinity ? now - this.firstLinkAt >= HEADROOM_FIRST_MS : now - this.headroom.lastAt >= every
    if (due && !this.backloggedNow) void this.discover()
  }

  /**
   * Pushes background bytes onto every open connection for 1.5 s (session/headroom.ts) and takes
   * what each delivered as a backlogged window. Returns the uplink's capacity afterwards, or null if
   * no probe ran.
   */
  async discover(): Promise<number | null> {
    const conns = this.openConns()
    const snap = () => new Map(conns.map(([conn]) => [conn, this.uplink.snapshot(conn, conn.probeLink)]))
    const r = await this.headroom.run(
      conns.map(([conn]) => conn.probeLink),
      snap,
    )
    if (!r) return null
    const windows: ConnWindow[] = []
    for (const [conn, { peer }] of conns) {
      const a = r.start.get(conn)
      const b = r.end.get(conn)
      if (!a || !b || !conn.isOpen) continue
      windows.push({ ...linkWindow(conn, peer, a, b), active: true, backlogged: true })
    }
    this.capacity.update(performance.now(), windows, { probe: true })
    this.updateOffers()
    this.onChange()
    return this.capacity.uplinkKbps
  }

  /** Polls getStats() on every open connection (mesh links and lanes) into its tracker. */
  private async pollLinkStats(): Promise<void> {
    if (this.pollingStats) return
    this.pollingStats = true
    try {
      await Promise.all(
        this.openConns().map(async ([conn, { tracker }]) => {
          const report = await conn.stats?.()
          const r = report && parseLinkStats(report)
          if (r) tracker.update(r, performance.now())
        }),
      )
    } finally {
      this.pollingStats = false
    }
  }

  /** The records of the open connections to `peer`, by lane. */
  private recsOf(peer: string): [PairConn, ConnRecord][] {
    return [...this.connRecs].filter(([, r]) => r.peer === peer).sort((a, b) => a[1].lane - b[1].lane)
  }

  /**
   * Per connection to `peer` (Peers panel, e2e): getStats() path stats (RTT now and baseline, wire
   * send rate, relayed, SCTP congestion window where the browser exposes it) and the live-media
   * queueing and drops of the last window.
   */
  linkStatsFor(peer: string): LinkRow[] {
    const kbps = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))
    const ms = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)
    const now = performance.now()
    return this.recsOf(peer).map(([conn, rec]) => {
      const s = rec.tracker.current(now)
      const r = rec.rate
      const cap = this.capacity.conn(conn)
      return {
        lane: rec.lane,
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
        cwnd: s?.cwnd ?? null,
      }
    })
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

  /** The link from this peer to `peer` over the last window, all its connections together (Topology). */
  linkRate(peer: string): { drops: number; queueMs: number; backlogged: boolean; capKbps: number | null } | null {
    const rs = this.recsOf(peer).flatMap(([, r]) => (r.rate ? [r.rate] : []))
    if (!rs.length) return null
    const cap = this.capacity.peer(peer).kbps
    return {
      drops: Math.round(rs.reduce((a, r) => a + r.drops, 0) * 10) / 10,
      queueMs: Math.max(...rs.map((r) => r.queueMs)),
      backlogged: rs.some((r) => r.backlogged),
      capKbps: cap === null ? null : Math.round(cap),
    }
  }

  /** What the connections to `peer` carry together (Peers panel), and whether they were its bottleneck. */
  peerCapacity(peer: string): { kbps: number | null; bound: boolean } {
    return this.capacity.peer(peer)
  }

  /** Path RTT inflation to `peer` over its baseline (display only: the Peers panel's "+N ms"). */
  pathQueueFor(peer: string): { inflationMs: number; queued: boolean } | null {
    const p = pathInflation(
      this.recsOf(peer).map(([, r]) => r.tracker.current(performance.now())),
      RTT_QUEUE_SHOWN_MS,
    )
    return p ? { inflationMs: Math.round(p.inflationMs), queued: p.inflated } : null
  }

  // --- debug / e2e -------------------------------------------------------------------------------

  /** The stage player (null while presenting or before anything is live). */
  get player(): Subscription['player'] | null {
    return this.stageView().player
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
    this.reconcileTimer?.()
    this.reconcileTimer = null
    this.timers.forEach((cancel) => cancel())
    this.timers = []
    this.stopSharing()
    for (const sub of this.subs.values()) sub.close()
    this.subs.clear()
    await this.mesh.leave()
  }
}
