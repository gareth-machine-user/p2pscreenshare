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
import type { ChannelAnnouncement } from '../mesh/records'
import { fromBase64Url } from '../net/lobby'
import { Uplink } from '../net/uplink'
import type { PeerMsg, PublisherMsg, SubscriberMsg, TopologyReport } from '../proto/messages'
import { verifyFragment } from '../proto/signing'
import { RelayNode } from '../relay/relayNode'
import { CapacityEstimator, rebalanceWeights, splitBudget, stripeKbpsFor } from './capacity'
import { PublishedStream, type ChannelPublisher, type PublisherContext, type ShareOptions } from './publisher'
import { Subscription, type SubscriptionContext } from './subscription'
import { after, every } from '../net/ticker'

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
}

export interface LiveChannel {
  ann: ChannelAnnouncement
  publisher: string
}

export type ViewQuality = 'auto' | 'full' | 'preview'
/** Where the stage picture comes from. */
export type StageSource = 'local' | 'full' | 'preview' | 'none'
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

/** Auto quality falls back to the preview when the full stream stalls this long... */
const AUTO_STALL_MS = 6000
/** ...and returns once it plays smoothly again for this long. */
const AUTO_RECOVER_MS = 4000

const PROBE_DURATION_MS = 1500
const PROBE_CHUNK = 16 * 1024
const PROBE_PEERS = 3
const PROBE_REPLY_TIMEOUT_MS = 3000
const SUBSCRIBER_MSGS = new Set(['subscribe', 'unsubscribe', 'stripe-ok', 'reattach', 'need-key', 'stats', 'topo-req'])
const PUBLISHER_MSGS = new Set(['set-parent', 'add-child', 'remove-child', 'position'])

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
  private probing = false
  private probePeersUsed = 0
  private probeRx = new Map<string, { firstAt: number; lastAt: number; bytes: number }>()
  private probeReplies = new Map<string, (r: { bytes: number; ms: number }) => void>()
  private uplinkSampleAt = { at: performance.now(), sent: 0, sentItems: 0, dropped: 0 }
  private uplinkNow = { kbps: 0, dropRate: 0 }
  private reconcileTimer: (() => void) | null = null
  private timers: (() => void)[] = []
  private topoWatching = new Set<number>()
  private lastProbeAt = -Infinity
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
    })
    this.relay = new RelayNode(this.uplink, (id) => this.mesh.linkFor(id))
    this.relay.verifier = (raw, ch) => this.verify(raw, ch)
    this.relay.onFragment = (frag, from) => this.subs.get(frag.header.channel >>> 0)?.onFragment(frag, from)

    const m = this.mesh
    m.onMedia = (data, from) => this.relay.receive(data, from)
    m.onBufferLow = () => this.uplink.kick()
    m.onBinary = (data, from) => this.onProbeChunk(data, from)
    m.onApp = (msg, from) => this.handle(msg as PeerMsg, from)
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
    this.timers.push(every(2000, () => this.sampleUplink()))
    this.timers.push(every(1000, () => this.maybeProbe()))
    this.timers.push(every(500, () => this.checkAutoQuality()))
    this.timers.push(every(REBALANCE_MS, () => this.rebalance()))
    this.timers.push(every(2000, () => this.checkAutoBitrate()))
    this.timers.push(every(30_000, () => this.maybeReprobe()))
    this.timers.push(every(100, () => this.logStage()))
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
    return this.liveChannels()
      .filter((c) => c.ann.kind === 'full')
      .sort((a, b) => a.ann.startedAt - b.ann.startedAt)
  }

  private rebuildChannels(): void {
    const next = new Map<number, LiveChannel>()
    const add = (publisher: string, anns: ChannelAnnouncement[]) => {
      if (!this.mayPublish(publisher)) return
      for (const ann of anns) next.set(ann.id >>> 0, { ann, publisher })
    }
    for (const rec of this.mesh.members()) add(rec.id, rec.channels)
    add(this.selfId, this.ownChannels().map((c) => c.announcement()))
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
    const streams = this.liveStreams()
    if (!this.selected || !streams.some((s) => s.publisher === this.selected)) {
      this.selected = streams.find((s) => s.publisher !== this.selfId)?.publisher ?? streams[0]?.publisher ?? null
      this.autoFallback = false
    }
    const want = new Map<number, LiveChannel>()
    const add = (c: LiveChannel | undefined) => c && want.set(c.ann.id >>> 0, c)
    const stage = streams.find((s) => s.publisher === this.selected)
    if (stage && stage.publisher !== this.selfId) {
      if (this.quality !== 'preview') add(stage)
      if (this.quality === 'preview' || this.autoFallback) add(this.previewOf(stage.publisher))
    }
    if (streams.length >= 2) for (const s of streams) if (s.publisher !== this.selfId) add(this.previewOf(s.publisher))

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
    if (this.stageLog.length > 100) this.stageLog.shift()
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
      this.publishing = null
      stream.stop()
      throw e
    }
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

  /** Re-measures upload every 5 minutes while relay load is light. */
  private maybeReprobe(): void {
    const now = performance.now()
    const est = this.capacity.estimateKbps
    if (est === null || now - this.lastProbeAt < REPROBE_EVERY_MS) return
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
    if (!msg || typeof msg !== 'object') return
    if (msg.t === 'publish-req') {
      if (!this.isOwner || this.mayPublish(from)) return
      if (this.policy === 'closed') this.sendTo(from, { t: 'publish-deny' })
      else if (this.policy === 'open') void this.respond(from, 'allow')
      else this.requests.set(from, { id: from, at: Date.now() })
      this.onChange()
      return
    }
    if (msg.t === 'publish-deny') {
      if (from === this.ownerId && this.requestState === 'waiting') this.requestState = 'denied'
      this.onChange()
      return
    }
    if (msg.t === 'probe-end') {
      this.onProbeEnd(msg.id, from)
      return
    }
    if (msg.t === 'probe-result') {
      this.probeReplies.get(from)?.({ bytes: msg.bytes, ms: msg.ms })
      return
    }
    if (SUBSCRIBER_MSGS.has(msg.t)) {
      const m = msg as SubscriberMsg
      this.ownChannels().find((c) => c.id === m.ch >>> 0)?.handle(m, from)
      return
    }
    if (PUBLISHER_MSGS.has(msg.t)) {
      const m = msg as PublisherMsg
      // Tree commands for a channel come only from that channel's publisher.
      const sub = this.subs.get(m.ch >>> 0)
      if (sub && sub.publisher === from) sub.handle(m)
      return
    }
    if (msg.t === 'reprobe') {
      const sub = this.subs.get(msg.ch >>> 0)
      if (sub && sub.publisher === from && performance.now() - this.lastProbeAt > REPROBE_MIN_GAP_MS) void this.probe()
      return
    }
    if (msg.t === 'topo') {
      const live = this.channels.get(msg.ch >>> 0)
      if (!live || live.publisher !== from) return
      void gunzip(fromBase64Url(msg.z))
        .then((json) => {
          this.topologyReports.set(msg.ch >>> 0, JSON.parse(json) as TopologyReport)
          this.onChange()
        })
        .catch(() => {})
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
    this.capacity.observe(this.uplinkNow.kbps, this.uplinkNow.dropRate)
    const dropRate = Math.round(this.uplinkNow.dropRate * 1000) / 1000
    if (dropRate !== (this.mesh.record.dropRate ?? 0)) this.mesh.updateRecord({ dropRate })
    this.updateOffers()
  }

  /** Probes once neighbours exist, and again once if the first probe had fewer than three. */
  private maybeProbe(): void {
    if (this.probing) return
    const open = [...this.mesh.conns.values()].filter((c) => c.isOpen)
    if (!open.length) return
    if (this.capacity.probeKbps !== null && (this.probePeersUsed >= PROBE_PEERS || open.length <= this.probePeersUsed)) return
    void this.probe()
  }

  /**
   * Measures this peer's upload: a paced 1.5 s probe sent in parallel to up to 3 random
   * neighbours, which report bytes received. Their sum, plus whatever the uplink sent meanwhile
   * (relayed or published media share the same pipe), is the estimate. Several receivers mean we
   * measure our own uplink, not one receiver's downlink.
   */
  async probe(): Promise<number | null> {
    if (this.probing) return null
    this.probing = true
    this.lastProbeAt = performance.now()
    try {
      const targets = [...this.mesh.conns.values()]
        .filter((c) => c.isOpen)
        .sort(() => Math.random() - 0.5)
        .slice(0, PROBE_PEERS)
      if (!targets.length) return null
      const replies = targets.map(
        (c) =>
          new Promise<{ bytes: number; ms: number }>((resolve) => {
            const t = setTimeout(() => resolve({ bytes: 0, ms: 0 }), PROBE_DURATION_MS + PROBE_REPLY_TIMEOUT_MS)
            this.probeReplies.set(c.remoteId, (r) => {
              clearTimeout(t)
              resolve(r)
            })
          }),
      )
      // Probe chunks join the uplink queue at background priority: they fill only the upload that
      // media leaves spare (and go through the debug shaper), so a probe never delays the stream.
      const start = performance.now()
      const sentBefore = this.uplink.stats.sentBytes
      const links = targets.map((c) => c.probeLink)
      for (const l of links) this.uplink.setBackground(l)
      const probeId = crypto.getRandomValues(new Uint32Array(1))[0]
      const chunk = () => {
        const c = new Uint8Array(PROBE_CHUNK)
        new DataView(c.buffer).setUint32(0, probeId, true)
        return c
      }
      let probeBytes = 0
      while (performance.now() - start < PROBE_DURATION_MS) {
        for (const l of links) {
          for (let i = 0; i < 4 && l.isOpen && this.uplink.queued(l) < 4; i++) {
            this.uplink.send(l, chunk(), 0, PROBE_DURATION_MS)
            probeBytes += PROBE_CHUNK
          }
        }
        await new Promise((r) => setTimeout(r, 4))
      }
      // The end marker goes on the reliable control channel, outside the (possibly long) uplink
      // queue: each receiver reports what arrived until then.
      for (const c of targets) this.sendTo(c.remoteId, { t: 'probe-end', id: probeId })
      // Media sent meanwhile (the uplink's byte count includes the probe chunks: subtract them).
      const mediaBytes = Math.max(0, this.uplink.stats.sentBytes - sentBefore - probeBytes)
      const mediaKbps = (mediaBytes * 8) / Math.max(1, performance.now() - start)
      // Receivers see the probe in bursts at different times: divide the total by the longest window.
      const got = await Promise.all(replies)
      const window = Math.max(...got.map((r) => r.ms))
      const probeKbps = window > 0 ? (got.reduce((a, r) => a + r.bytes, 0) * 8) / window : 0
      const kbps = probeKbps > 0 ? probeKbps + mediaKbps : 0
      for (const c of targets) this.probeReplies.delete(c.remoteId)
      if (kbps > 0) {
        this.capacity.setProbe(kbps)
        this.probePeersUsed = targets.length
        this.updateOffers()
        this.onChange()
      }
      return kbps
    } finally {
      this.probing = false
    }
  }

  /** Receiving side of a neighbour's probe: count bytes per probe id until its end marker. */
  private onProbeChunk(data: Uint8Array, from: string): void {
    if (data.byteLength < 4) return
    const key = `${from}:${new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true)}`
    const now = performance.now()
    const st = this.probeRx.get(key)
    if (!st) {
      // The first chunk only starts the clock.
      this.probeRx.set(key, { firstAt: now, lastAt: now, bytes: 0 })
      for (const [k, v] of this.probeRx) if (now - v.lastAt > 10_000) this.probeRx.delete(k)
    } else {
      st.bytes += data.byteLength
      st.lastAt = now
    }
  }

  private onProbeEnd(id: number, from: string): void {
    const key = `${from}:${id >>> 0}`
    const st = this.probeRx.get(key)
    this.probeRx.delete(key)
    this.sendTo(from, { t: 'probe-result', bytes: st?.bytes ?? 0, ms: st ? st.lastAt - st.firstAt : 0 })
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
