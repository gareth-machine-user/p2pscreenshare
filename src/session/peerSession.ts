// Every peer runs the same PeerSession: a member of the full mesh, a relay for the channels it
// watches, and (with the right to publish) a publisher planning its own channels' trees.
//
// - Membership: the mesh (mesh/mesh.ts): links, gossip records, chat.
// - Publisher: PublishedStream + one ChannelPublisher per channel (session/publisher.ts).
// - Subscriber: one Subscription per watched channel (session/subscription.ts).
// - Relay: one RelayNode for every channel, forwarding over the mesh links' media channels.
// - Capacity: an upload probe to 3 neighbours, split into relay slots per watched channel.
import { ban, grant, isBanned, mayPublish as mayPublishDoc, revoke, setPolicy, type PublishPolicy } from '../mesh/auth'
import { importPublicKey, type PeerIdentity } from '../mesh/identity'
import { gunzip } from '../mesh/envelope'
import { Mesh } from '../mesh/mesh'
import { laneSample, peerLinkRates, type LaneSample } from '../mesh/lanes'
import type { ChannelAnnouncement } from '../mesh/records'
import { fromBase64Url } from '../net/lobby'
import { Uplink } from '../net/uplink'
import { LinkStatsTracker, parseLinkStats, pathInflation, type LinkStats } from '../net/linkStats'
import { isTopologyReport, parsePeerMsg, type EncoderRates, type PeerMsg, type TopologyReport, type UplinkRates } from '../proto/messages'
import { RateWindow, round1 } from './rates'
import { verifyFragment } from '../proto/signing'
import { RelayNode } from '../relay/relayNode'
import { CapacityEstimator, rebalanceWeights, splitBudget, stripeKbpsFor, uplinkIsFull, type PeerLinkState, type UplinkFull } from './capacity'
import { CONGESTION_DEFAULTS, CongestionController, type CongestionConfig } from './congestion'
import { PublishedStream, type ChannelPublisher, type PublisherContext, type ShareOptions } from './publisher'
import { Subscription, type SubscriptionContext } from './subscription'
import { ChannelOwners } from './channelOwners'
import { liveStreamsOf, planStage, type StageSource, type ViewQuality } from './stage'
import { UploadProbe } from './uploadProbe'
import { after, every, tabHidden } from '../net/ticker'
import { tuning } from '../tuning'

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
  /** Path RTT (ICE candidate pair) now, and its 2-minute minimum. */
  rttMs: number | null
  baselineMs: number | null
  /** The RTT refreshed recently. */
  fresh: boolean
  /** Live-media queueing (uplink queue + send buffer) and drops/s over the last window. */
  queueMs: number | null
  drops: number | null
  congested: boolean
  relayed: boolean | null
  /** SCTP congestion window (bytes), if the browser exposes sctp-transport stats (Chrome doesn't). */
  cwnd: number | null
  availableKbps: number | null
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

/** Re-measure upload this often when relaying lightly (a network may have improved)... */
const REPROBE_EVERY_MS = 5 * 60_000
/** ...but never more often than this, whoever asks. */
const REPROBE_MIN_GAP_MS = 30_000
/** Budget weights shift towards channels with a deficit this often. */
const REBALANCE_MS = 10_000
/** Auto quality: wait this long between automatic restarts of a stream. */
const AUTO_RESTART_GAP_MS = 30_000
/**
 * Congestion control for a presenter's bitrate (session/congestion.ts): while its uplink is full,
 * settle just below the rate the uplink actually carried; after 5 s clean, return to that rate and
 * probe above it slowly, never above the chosen quality.
 */
const CC_CONFIG: CongestionConfig = { ...CONGESTION_DEFAULTS, severeQueueMs: 2 * tuning.ccQueueMs }
/** The reason shown names drops above this rate (per second), else the queueing. */
const CC_DROPS_PER_S = 5
const CC_QUEUE_MS = tuning.ccQueueMs
/** A link is congested when it drops this many live fragments per second (or queues past CC_QUEUE_MS). */
const LINK_DROPS_PER_S = 2
/** The uplink is full when more than this share of active peers is congested (with queueing paths) at once. */
const UPLINK_FULL_SHARE = 0.5
/** Path RTT inflation that means queueing in the network, at least (capacity.ts uplinkIsFull). */
const CC_RTT_INFLATION_MS = tuning.ccRttInflationMs
/**
 * The debug upload cap (a token bucket) stands in for a slow uplink: sending this close to it, its
 * queue is the bottleneck's, which on a real link would sit in the router and inflate path RTTs.
 */
const SHAPER_FULL_SHARE = 0.85
/** Each connection's getStats() (path RTT, wire rates) is polled this often. */
const LINK_STATS_MS = 2000

/** Auto quality falls back to the preview when the full stream stalls this long... */
const AUTO_STALL_MS = 6000
/** ...and returns once it plays smoothly again for this long. */
const AUTO_RECOVER_MS = 4000

/** Uplink stats (and the congestion controller and auto bitrate that use them) run this often. */
const UPLINK_SAMPLE_MS = 2000
const AUTO_BITRATE_CHECK_MS = 2000
/** Look for neighbours to run the first upload probes against this often. */
const PROBE_CHECK_MS = 1000
const AUTO_QUALITY_CHECK_MS = 500
/** How often to consider a light-load reprobe (see REPROBE_EVERY_MS). */
const REPROBE_CHECK_MS = 30_000
/** Debug/e2e: sample the stage source this often, keeping this many changes. */
const STAGE_LOG_MS = 100
const STAGE_LOG_MAX = 100

export class PeerSession implements PublisherContext, SubscriptionContext {
  readonly mesh: Mesh
  readonly uplink: Uplink
  readonly relay: RelayNode
  readonly capacity = new CapacityEstimator()
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
  private uploadProbe: UploadProbe
  private uplinkSampleAt = { at: performance.now(), sent: 0, sentItems: 0, dropped: 0 }
  private uplinkNow = { kbps: 0, dropRate: 0 }
  /** This peer's uplink and (when presenting) encoder, per second over the last 2 s window. */
  uplinkStatsNow: UplinkRates | null = null
  encoderStatsNow: EncoderRates | null = null
  private uplinkWindow = new RateWindow<{ bytes: number; t0: number; t1: number; t2: number; stalls: number }>()
  private lastQueueDelay = { sum: 0, n: 0 }
  private reconcileTimer: (() => void) | null = null
  private timers: (() => void)[] = []
  private topoWatching = new Set<number>()
  private cc = new CongestionController(CC_CONFIG)
  /** Why the congestion controller last moved the bitrate (shown in Stats). */
  ccReason: string | null = null
  /** What last made the controller lower the bitrate, and the uplink rate it saw then. */
  private ccCause: { kind: 'uplink'; sendingKbps: number } | null = null
  /** Per peer: live-media drops/s and queueing on the link from this peer (Topology panel). */
  readonly linkRates = new Map<string, { drops: number; queueMs: number; congested: boolean }>()
  /** Per peer: path RTT inflation over its baseline (ms; null: no RTT signal) and whether it counts as queueing. */
  readonly pathQueue = new Map<string, { inflationMs: number | null; queued: boolean | null }>()
  /** Whether this peer's uplink itself is full (most peers congested together, over queueing paths). */
  uplinkFull: UplinkFull | null = null
  /** Per connection (mesh link or lane): its getStats() history (see net/linkStats.ts). */
  private linkTrackers = new Map<object, { peer: string; lane: number; tracker: LinkStatsTracker }>()
  private pollingStats = false
  /** Per connection: live-media numbers over the last window. */
  private laneRates = new Map<object, { sentKbps: number; drops: number; queueMs: number; congested: boolean }>()
  private linkLast = new Map<object, { sent: number; bytes: number; drops: number; qSum: number; qN: number }>()
  private lastAutoRestart = -Infinity
  private stallSince: number | null = null
  private smoothSince: number | null = null
  private lastStageDecoded = 0

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
    })
    // Stripes of one pair spread over its media lanes (each lane gets its own uplink queue).
    this.relay = new RelayNode(this.uplink, (id, stripe) => this.mesh.mediaLinkFor(id, stripe))
    this.relay.verifier = (raw, ch) => this.verify(raw, ch)
    this.relay.onFragment = (frag, from) => this.subs.get(frag.header.channel >>> 0)?.onFragment(frag, from)
    this.uploadProbe = new UploadProbe({
      targets: () =>
        [...this.mesh.conns.values()].map((c) => ({
          remoteId: c.remoteId,
          isOpen: c.isOpen,
          probeLink: c.probeLink,
          probeLinks: this.mesh.probeLinksFor(c.remoteId),
        })),
      uplink: this.uplink,
      capacity: this.capacity,
      sendTo: (to, msg) => this.sendTo(to, msg),
      onProbed: () => {
        this.updateOffers()
        this.onChange()
      },
    })

    const m = this.mesh
    m.onMedia = (data, from) => this.relay.receive(data, from)
    m.onBufferLow = () => this.uplink.kick()
    m.onBinary = (data, from) => this.uploadProbe.onChunk(data, from)
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
      if (id === this.ownerId && this.requestState === 'owner-away') this.requestPublish()
      // A publisher we watch is reachable again: make sure it still has us.
      for (const sub of this.subs.values()) if (sub.publisher === id) sub.subscribe()
      for (const ch of this.topoWatching) if (this.channels.get(ch)?.publisher === id) this.sendTo(id, { t: 'topo-req', ch, on: true })
    }
    m.onChange = () => this.onChange()
  }

  async start(): Promise<void> {
    await this.mesh.start()
    this.timers.push(every(UPLINK_SAMPLE_MS, () => this.sampleUplink()))
    this.timers.push(every(PROBE_CHECK_MS, () => this.uploadProbe.maybeProbe()))
    this.timers.push(every(AUTO_QUALITY_CHECK_MS, () => this.checkAutoQuality()))
    this.timers.push(every(REBALANCE_MS, () => this.rebalance()))
    this.timers.push(every(AUTO_BITRATE_CHECK_MS, () => this.checkAutoBitrate()))
    this.timers.push(every(REPROBE_CHECK_MS, () => this.maybeReprobe()))
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

  setQuality(q: ViewQuality): void {
    this.quality = q
    this.autoFallback = false
    this.scheduleReconcile(0)
  }

  /**
   * Auto quality: show the preview while the full stream stalls, and go back once it recovers. A
   * stall means frames stopped arriving: a static screen legitimately runs at a few fps (only
   * the idle refresh), and treating that as a stall would flip the stage back and forth.
   */
  private checkAutoQuality(): void {
    if (this.quality !== 'auto') return
    const full = this.stageSub
    const now = performance.now()
    if (!full) {
      this.stallSince = this.smoothSince = null
      return
    }
    const decoded = full.player.stats.decodedFrames
    const progressing = decoded > this.lastStageDecoded
    this.lastStageDecoded = decoded
    if (!this.autoFallback) {
      this.stallSince = progressing ? null : (this.stallSince ?? now)
      if (this.stallSince !== null && now - this.stallSince > AUTO_STALL_MS && decoded > 0) {
        this.autoFallback = true
        this.smoothSince = null
        this.scheduleReconcile(0)
      }
    } else {
      this.smoothSince = progressing ? (this.smoothSince ?? now) : null
      if (this.smoothSince !== null && now - this.smoothSince > AUTO_RECOVER_MS) {
        this.autoFallback = false
        this.stallSince = null
        this.scheduleReconcile(0)
      }
    }
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
    await this.mesh.updateAuth((doc) => setPolicy(doc, policy))
    if (policy === 'closed') await this.respond('', 'deny-all')
    if (policy === 'open') await this.respond('', 'allow-all')
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
    return this.capacity.estimateKbps
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
    const split = splitBudget(this.capacity.estimateKbps, own, watched)
    this.rootSlotsByChannel = split.rootSlots
    const offers = Object.fromEntries(Object.entries(split.offers).map(([ch, n]) => [String(ch), n]))
    const subs = [...this.subs.keys()]
    const rec = this.mesh.record
    const capacityKbps = this.capacity.estimateKbps === null ? null : Math.round(this.capacity.estimateKbps)
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
   * Re-measures upload every 5 minutes while relay load is light. Not while the tab is hidden:
   * that is a backgrounded presenter's usual state, where throttling would spoil the probe.
   */
  private maybeReprobe(): void {
    if (tabHidden()) return
    const now = performance.now()
    const est = this.capacity.estimateKbps
    if (est === null || now - this.uploadProbe.lastProbeAt < REPROBE_EVERY_MS) return
    if (this.uplinkNow.kbps < est * 0.3) void this.probe()
  }

  /**
   * Auto quality for a presenter: when the audience's upload can't carry the stream for 10 s, the
   * publisher's sharing controls warn, and with Auto quality the encoder drops to a bitrate it
   * can carry (a brief blip).
   */
  private checkAutoBitrate(): void {
    const s = this.publishing
    const full = s?.full
    if (!s || !full?.limited || !this.autoBitrate) return
    const now = performance.now()
    if (now - this.lastAutoRestart < AUTO_RESTART_GAP_MS || full.limited.feasibleKbps >= s.opts.bitrateKbps) return
    this.lastAutoRestart = now
    // In place: re-capturing would need the user to pick the screen again.
    void s.setQuality(full.limited.feasibleKbps)
  }

  /** Congestion control: see CC_* above. Runs on each 2 s uplink sample. */
  private adaptBitrate(now: number): void {
    const s = this.publishing
    const full = s?.full
    const up = this.uplinkStatsNow
    if (!s || !full || !up) return
    const drops = up.drops[0] + up.drops[1] + up.drops[2]
    // Only a full uplink lowers the bitrate. One slow viewer congests only its own link, which
    // already sheds enhancement frames for that viewer alone; its Auto quality can fall back to
    // the preview. Viewers' own losses (their downlinks, relays) don't count either.
    const full_ = this.uplinkFull
    // Climb back, but not past what the audience's relay slots can carry (when that's the limit).
    const cap = full.limited ? Math.max(full.limited.feasibleKbps, full.kbps) : s.ceilingKbps
    // This stream's wire rate at a video bitrate: one stripe copy per direct child. The preview
    // channel and relayed channels are the controller's "other" traffic.
    const edges = this.directEdges(full)
    const ownWireKbpsAt = (v: number) => edges * stripeKbpsFor(v, full.k, full.withAudio)
    const d = this.cc.sample({
      now,
      full: !!full_,
      sentKbps: up.kbps,
      currentKbps: full.kbps,
      maxKbps: Math.min(cap, s.ceilingKbps),
      dropsPerS: drops,
      queueMs: up.queueMs,
      ownWireKbpsAt,
    })
    // While full, what the uplink manages to send is about what it can carry.
    if (full_) this.ccCause = { kind: 'uplink', sendingKbps: this.cc.sendingKbps ?? up.kbps }
    if (!d) return
    if (full_) {
      const what = drops > CC_DROPS_PER_S ? `${Math.round(drops)} fragments/s dropped` : `${up.queueMs} ms queueing`
      const why = { rtt: 'path RTT inflated', loss: 'heavy drops', fallback: 'path RTT unknown' }[full_.signal]
      this.ccReason = `lowered: your uplink is full (${full_.congested} of ${full_.active} peers congested, ${why}; ${what}); ${d.reason}`
    } else this.ccReason = `raised: ${d.reason}`
    s.adaptBitrate(d.kbps)
    if (full.kbps >= s.ceilingKbps) this.ccCause = null
  }

  /** Stripe copies this peer sends of its own channel: one per direct child (at least one per stripe once anyone watches). */
  private directEdges(full: ChannelPublisher): number {
    let n = 0
    for (const ps of Object.values(full.topology.parents)) for (const p of ps) if (p === this.selfId) n++
    return Math.max(n, full.subscribers.size ? full.stripes : 0)
  }

  /**
   * Why the presenter's bitrate is below its chosen quality, in numbers: what its uplink manages
   * to send, and what this stream needs at the chosen quality (one stripe per direct child, for
   * every stripe). Null when it runs at full quality.
   */
  bitrateClamp(): {
    currentKbps: number
    ceilingKbps: number
    cause: 'uplink' | 'audience'
    sendingKbps: number
    neededKbps: number
    directEdges: number
    stripes: number
    viewerLossPct: number
  } | null {
    const s = this.publishing
    const full = s?.full
    if (!s || !full || full.kbps >= s.ceilingKbps) return null
    const directEdges = this.directEdges(full)
    // Nominal stripe rate at the chosen quality: a lower bound (encoders overshoot).
    const stripeAtCeiling = stripeKbpsFor(s.ceilingKbps, full.k, full.withAudio)
    return {
      currentKbps: full.kbps,
      ceilingKbps: s.ceilingKbps,
      cause: this.ccCause?.kind ?? (full.limited ? 'audience' : 'uplink'),
      sendingKbps: Math.round(this.ccCause?.sendingKbps ?? this.uplinkStatsNow?.kbps ?? 0),
      neededKbps: Math.round(directEdges * stripeAtCeiling),
      directEdges,
      stripes: full.stripes,
      viewerLossPct: 0,
    }
  }

  /**
   * Auto mode picks a second parity stripe when the lobby has enough relays: at least two capable
   * relays (two stripes of upload) per stripe.
   */
  autoParity(k: number, m: number, bitrateKbps: number): number {
    const r = stripeKbpsFor(bitrateKbps, k, true)
    const relays = this.mesh.members().filter((rec) => (rec.capacityKbps ?? 0) * 0.75 >= 2 * r).length
    return relays >= 2 * (k + 2) ? Math.max(m, 2) : m
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
      case 'publish-deny':
        if (from === this.ownerId && this.requestState === 'waiting') this.requestState = 'denied'
        this.onChange()
        return
      case 'need-gop':
        // From a child on our trees (as a relay, or as the channel's publisher): the relay checks.
        this.relay.requestReplay(msg.ch >>> 0, msg.stripes, from)
        return
      case 'probe-end':
        this.uploadProbe.onEnd(msg.id, from)
        return
      case 'probe-result':
        this.uploadProbe.onResult(from, { bytes: msg.bytes, ms: msg.ms })
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
      case 'reprobe': {
        const sub = this.subs.get(msg.ch >>> 0)
        if (sub && sub.publisher === from && performance.now() - this.uploadProbe.lastProbeAt > REPROBE_MIN_GAP_MS) void this.probe()
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
    this.sampleLinks(dt)
    this.adaptBitrate(now)
    // Drops on one slow link say nothing about this peer's upload: only a full uplink caps it.
    this.capacity.observe(this.uplinkNow.kbps, this.uplinkFull ? this.uplinkNow.dropRate : 0)
    const dropRate = Math.round(this.uplinkNow.dropRate * 1000) / 1000
    if (dropRate !== (this.mesh.record.dropRate ?? 0)) this.mesh.updateRecord({ dropRate })
    this.updateOffers()
  }

  /**
   * Per-peer rates over the last window, and whether the uplink itself is full (capacity.ts
   * uplinkIsFull): more than half of the peers being sent media are congested at once, over paths
   * whose RTT shows queueing in the network (or with heavy drops). Congested over a flat RTT is the
   * connections' own ceiling, which lanes absorb.
   *
   * With media lanes a peer has several connections, each with its own congestion window. A peer
   * counts as congested only when most of its active lanes are: one lane backing up is that
   * connection's ceiling, which the stripes on the other lanes don't share.
   */
  private sampleLinks(dt: number): void {
    this.linkRates.clear()
    this.laneRates.clear()
    const samples: LaneSample[] = []
    for (const [link, c] of this.uplink.perLink) {
      const peer = this.mesh.peerOfLink(link)
      if (!peer) continue
      const last = this.linkLast.get(link) ?? { sent: 0, bytes: 0, drops: 0, qSum: 0, qN: 0 }
      this.linkLast.set(link, { sent: c.sentItems, bytes: c.sentBytes, drops: c.drops, qSum: c.queueDelaySum, qN: c.queueDelayN })
      const sentBytes = c.sentBytes - last.bytes
      const sample = laneSample(
        peer,
        {
          sentItems: c.sentItems - last.sent,
          sentBytes,
          drops: c.drops - last.drops,
          queueSum: c.queueDelaySum - last.qSum,
          queueN: c.queueDelayN - last.qN,
        },
        link.bufferedAmount,
        dt,
        { dropsPerS: LINK_DROPS_PER_S, queueMs: CC_QUEUE_MS },
      )
      if (!sample) continue
      samples.push(sample)
      this.laneRates.set(link, {
        sentKbps: Math.round((sentBytes * 8) / 1000 / dt),
        drops: Math.round(sample.drops * 10) / 10,
        queueMs: sample.queueN > 0 ? Math.round(sample.queueSum / sample.queueN) : 0,
        congested: sample.congested,
      })
    }
    for (const [peer, r] of peerLinkRates(samples)) this.linkRates.set(peer, r)
    for (const link of this.linkLast.keys()) if (!this.uplink.perLink.has(link as never)) this.linkLast.delete(link)

    const now = performance.now()
    const shaperFull = this.capKbps !== null && this.uplinkNow.kbps >= this.capKbps * SHAPER_FULL_SHARE
    this.pathQueue.clear()
    const peers: PeerLinkState[] = []
    for (const [peer, r] of this.linkRates) {
      const path = pathInflation(this.connStats(peer, now).map((l) => l.stats), CC_RTT_INFLATION_MS)
      const queued = shaperFull || (path?.inflated ?? null)
      this.pathQueue.set(peer, { inflationMs: path ? Math.round(path.inflationMs) : null, queued })
      peers.push({ congested: r.congested, drops: r.drops, pathQueued: queued })
    }
    this.uplinkFull = uplinkIsFull(peers, UPLINK_FULL_SHARE)
  }

  /** Polls getStats() on every open connection (mesh links and lanes) into its tracker. */
  private async pollLinkStats(): Promise<void> {
    if (this.pollingStats) return
    this.pollingStats = true
    try {
      const seen = new Set<object>()
      const polls: Promise<void>[] = []
      for (const peer of [...this.mesh.conns.keys()]) {
        for (const { lane, conn } of this.mesh.connectionsOf(peer)) {
          if (!conn.stats) continue
          seen.add(conn)
          let t = this.linkTrackers.get(conn)
          if (!t) this.linkTrackers.set(conn, (t = { peer, lane, tracker: new LinkStatsTracker() }))
          const { tracker } = t
          polls.push(
            conn.stats().then((report) => {
              const r = report && parseLinkStats(report)
              if (r) tracker.update(r, performance.now())
            }),
          )
        }
      }
      for (const conn of this.linkTrackers.keys()) if (!seen.has(conn)) this.linkTrackers.delete(conn)
      await Promise.all(polls)
    } finally {
      this.pollingStats = false
    }
  }

  /** Each open connection to `peer` with its latest getStats()-derived stats, by lane. */
  private connStats(peer: string, now = performance.now()): { lane: number; link: object; stats: LinkStats | null }[] {
    const out: { lane: number; link: object; stats: LinkStats | null }[] = []
    for (const [link, t] of this.linkTrackers) if (t.peer === peer) out.push({ lane: t.lane, link, stats: t.tracker.current(now) })
    return out.sort((a, b) => a.lane - b.lane)
  }

  /**
   * Per connection to `peer` (Peers panel, e2e): getStats() path stats (RTT now and baseline, wire
   * send rate, relayed, SCTP congestion window where the browser exposes it) and the live-media
   * queueing and drops of the last window.
   */
  linkStatsFor(peer: string): LinkRow[] {
    const kbps = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))
    const ms = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v * 10) / 10)
    return this.connStats(peer).map(({ lane, link, stats: s }) => {
      const r = this.laneRates.get(link)
      return {
        lane,
        sendKbps: kbps(s?.sendKbps),
        recvKbps: kbps(s?.recvKbps),
        mediaKbps: r?.sentKbps ?? null,
        rttMs: ms(s?.rttMs),
        baselineMs: ms(s?.baselineMs),
        fresh: s?.fresh ?? false,
        queueMs: r?.queueMs ?? null,
        drops: r?.drops ?? null,
        congested: r?.congested ?? false,
        relayed: s?.relayed ?? null,
        cwnd: s?.sctp?.congestionWindow ?? null,
        availableKbps: kbps(s?.availableOutgoingKbps),
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
    for (const t of this.linkTrackers.values()) {
      const s = t.tracker.current(now)
      if (s?.sendKbps != null) send = (send ?? 0) + s.sendKbps
      if (s?.recvKbps != null) recv = (recv ?? 0) + s.recvKbps
    }
    return { sendKbps: send ?? this.uplinkStatsNow?.kbps ?? null, recvKbps: recv }
  }

  /** The link from this peer to `peer`, over the last window. */
  linkRate(peer: string): { drops: number; queueMs: number; congested: boolean } | null {
    return this.linkRates.get(peer) ?? null
  }

  /** Measures this peer's upload (see uploadProbe.ts); null if a probe is already running. */
  probe(): Promise<number | null> {
    return this.uploadProbe.probe()
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
      home: sub?.home ?? null,
      parents: sub ? [...sub.parents] : [],
      children: sub ? this.relay.allChildren(sub.channel).size : 0,
      childIds: sub ? [...this.relay.allChildren(sub.channel)] : [],
      probeKbps: this.capacity.estimateKbps,
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
      topology: JSON.parse(JSON.stringify(c?.topology ?? { parents: {}, home: {} })),
    }
  }

  async leave(): Promise<void> {
    this.timers.forEach((cancel) => cancel())
    this.stopSharing()
    for (const sub of this.subs.values()) sub.close()
    this.subs.clear()
    await this.mesh.leave()
  }
}
