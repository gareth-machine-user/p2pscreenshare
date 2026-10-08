// Full-mesh lobby membership.
//
// A joiner enters through any door peer (net/bootstrap.ts), receives a snapshot of the member
// records and recent chat, then connects to every other member. Signaling for a pair travels over
// the `ctl` channel of peers both sides are connected to (the door at first); each SDP is signed by
// its sender, so a relaying peer can't swap the DTLS fingerprints. The peer with the lower id makes
// the offer (no glare), and connections open in batches of 8.
//
// Each peer owns one signed record (mesh/records.ts) and sends it to all neighbours when it
// changes and as a heartbeat. Every few seconds each peer swaps a digest with one random neighbour
// and pulls whatever is newer, which repairs gaps where a pair can't talk directly. A peer is gone
// when nothing fresh has been heard about it, from anyone, for 6 s (or it said goodbye).
//
// When a pair's mesh link fails before opening (typically a NAT pair without TURN), both sides list
// each other as `unreachable` in their records, and retry after 60 s with backoff to 10 min. The
// pair stays in the lobby; planners just never make it a tree edge.
//
// Once a pair's mesh link is open, it may add media lanes: extra connections for its media only,
// signaled over the link's ctl channel (lanes.ts). connFor picks the one carrying a tree.
import { Rendezvous, type RendezvousOptions, type RendezvousPort } from '../net/bootstrap'
import { emptyAuth, isBanned, type AuthDoc } from './auth'
import { open, seal, type Envelope, type Typed } from './envelope'
import { peerIdOf, type PeerIdentity } from './identity'
import { MeshConn, type ConnFactory, type PeerConn } from './meshConn'
import { Lane, type LaneFactory } from './lane'
import type { PairConn } from './dataConn'
import { clampLanes, isLaneMsg, Lanes, type LaneMsg } from './lanes'
import { doorPeers, FailureDetector, GONE_MS, isMemberRecord, linkSuspected, RecordStore, retryDelayMs, SUSPECT_MS, type Digest, type MemberRecord } from './records'
import { after, every } from '../net/ticker'
import { storageGet, storageSet } from '../util/storage'

const HEARTBEAT_MS = 2000
const DIGEST_MS = 2000
const RTT_SAMPLE_MS = 10_000
const PING_IDLE_MS = 1000
/** Period of the main loop: pings, failure detection, connecting, door duty. */
const TICK_MS = 250
const CONNECT_BATCH = 8
/** Time for a relayed offer/answer exchange plus ICE before the attempt counts as failed. */
const CONNECT_ATTEMPT_MS = 15_000
/** A link that dropped after being open is retried this soon (the peer may still be around). */
const RELINK_MS = 2000
/** Two connections to one peer made within this window are crossed door offers (glare), not a reload. */
const GLARE_WINDOW_MS = 15_000
/** An offer while the open link was created this recently is a stale duplicate, not a reconnect. */
const FRESH_LINK_MS = 2000
/** Links to a kicked peer close this long after the news goes out, so it reaches the peer first. */
const KICK_CLOSE_DELAY_MS = 500
/** Links close this long after a goodbye record goes out, so it gets delivered. */
const LEAVE_CLOSE_DELAY_MS = 100
/** Seeking with no offer for this long while knowing no members: this peer starts the lobby. */
const ALONE_DOOR_MS = 5000
/** A member with no open links for this long goes back to the tracker to find the lobby again. */
const ISOLATED_MS = 3000
/**
 * How far a signaling message's `at` may be from this peer's clock. Peers' clocks are not synced
 * (net/clock.ts is the local clock), so this is mostly a skew allowance: a pair whose clocks differ
 * by more could never link through relays. Replays are refused by nonce however wide it is (a
 * nonce is kept as long as its `at` would pass), so the cost is only keeping nonces longer.
 */
const SIG_MAX_AGE_MS = 10 * 60_000
/** A knock doesn't restart an offer to the knocker made this recently (it is likely in flight). */
const KNOCK_KEEP_OFFER_MS = 5000
const CHAT_KEEP = 50
export const CHAT_MAX_LEN = 500
/**
 * Most a chat message's (sender-chosen) time may be ahead of this peer's clock. The log is ordered
 * by it, so a message dated far ahead would never be evicted and would push every newer one out.
 */
const CHAT_MAX_FUTURE_MS = 60_000
const CHAT_RATE = { count: 5, perMs: 5000 }

interface SigBody extends Typed {
  type: 'sig'
  from: string
  to: string
  kind: 'offer' | 'answer' | 'knock'
  sdp?: string
  nonce: string
  at: number
}

interface ChatBody extends Typed {
  type: 'chat'
  id: string
  from: string
  name: string
  text: string
  at: number
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
}

/** Messages on a mesh link's `ctl` channel (besides ping/pong, handled by MeshConn). */
type MeshMsg =
  | { t: 'rec'; env: Envelope }
  | { t: 'recs'; envs: Envelope[] }
  | { t: 'digest'; d: Digest; a?: number }
  | { t: 'pull'; ids: string[] }
  | { t: 'snapshot'; recs: Envelope[]; chat: Envelope[]; auth?: Envelope | null }
  | { t: 'auth'; env: Envelope }
  | { t: 'sig'; to: string; env: Envelope }
  | { t: 'chat'; env: Envelope }
  | { t: 'app'; m: unknown }
  | LaneMsg

export interface MeshOptions<C extends PeerConn = MeshConn> {
  joinCode: string
  identity: PeerIdentity
  ownerId: string
  name: string
  trackers?: string[]
  iceServers: RTCIceServer[]
  /** Debug: refuse mesh links with members of these names, as if ICE failed. */
  block?: string[]
  /** Tests: makes connections (default: a real MeshConn). */
  connect?: ConnFactory<C>
  /** Connections per pair (media lanes, see lanes.ts): 1..4, default 2. 1 = the mesh link only. */
  lanes?: number
  /** Tests: makes lanes (default: a real Lane). */
  connectLane?: LaneFactory
  /** Tests: makes the rendezvous (default: tracker bootstrap, net/bootstrap.ts). */
  rendezvous?: (opts: RendezvousOptions<C>) => RendezvousPort<C>
  /** Tests: where the owner keeps its decisions (default: localStorage). Must not throw. */
  storage?: KeyValueStore
}

type LinkStatus = 'open' | 'connecting' | 'unreachable' | 'none'

interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const localStore: KeyValueStore = { getItem: storageGet, setItem: storageSet }

/** Sliding-window rate limit. */
class RateWindow {
  private times: number[] = []

  constructor(private rate: { count: number; perMs: number }) {}

  /** Counts an event at `now`; false (and not counted) if the window is already full. */
  take(now: number): boolean {
    this.times = this.times.filter((t) => now - t < this.rate.perMs)
    if (this.times.length >= this.rate.count) return false
    this.times.push(now)
    return true
  }
}

export class Mesh<C extends PeerConn = MeshConn> {
  readonly selfId: string
  readonly ownerId: string
  readonly store = new RecordStore()
  /** Open or connecting links, by remote peer id. */
  readonly conns = new Map<string, C>()
  readonly detector = new FailureDetector(GONE_MS)
  chat: ChatMessage[] = []
  /** The owner's latest signed decisions (publish policy, grants, revocations, bans). */
  auth: AuthDoc = emptyAuth()
  trackersConnected = 0
  /** Joined: connected to at least one member, or started the lobby. */
  joined = false

  /** A member's record was first seen. */
  onMemberJoin: (id: string) => void = () => {}
  /** A member left or was declared gone. */
  onMemberLeave: (id: string) => void = () => {}
  onLinkOpen: (id: string) => void = () => {}
  onLinkClose: (id: string) => void = () => {}
  /** A member's record changed (any field). */
  onRecord: (rec: MemberRecord) => void = () => {}
  onApp: (msg: unknown, from: string) => void = () => {}
  onMedia: (data: Uint8Array, from: string) => void = () => {}
  /**
   * The path RTT of the mesh connection to a peer (ICE candidate pair, from the session's getStats
   * polling), if known. Unlike the ctl pings', it doesn't queue behind the connection's own backlog.
   */
  pathRttMs: (id: string) => number | null = () => null
  onBufferLow: () => void = () => {}
  onChat: (m: ChatMessage) => void = () => {}
  /** The owner's decisions changed. */
  onAuth: (doc: AuthDoc) => void = () => {}
  onChange: () => void = () => {}

  private self: MemberRecord
  private selfEnv: Envelope | null = null
  private authEnv: Envelope | null = null
  /** Peer ids of banned keys, so a kicked peer is refused even before its record is known. */
  private bannedIds = new Set<string>()
  private rendezvous: RendezvousPort<C>
  private connect: ConnFactory<C>
  /** Extra media connections per pair. */
  readonly lanes: Lanes
  /** The chat log with each message's envelope (to hand on), ordered by time like `chat`. */
  private chatLog: { m: ChatMessage; env: Envelope }[] = []
  private chatSent = new RateWindow(CHAT_RATE)
  private chatByAuthor = new Map<string, RateWindow>()
  /** Links whose first snapshot (and its chat history) has arrived. */
  private snapshotted = new WeakSet<C>()
  /** Per remote: failed attempts and when to try again. */
  private retry = new Map<string, { attempts: number; at: number }>()
  /** Outgoing offers awaiting an answer, by remote id. */
  private pendingOffers = new Map<string, { conn: C; nonce: string }>()
  /** Signaling nonces already handled, with the wall-clock time after which a replay is too old anyway. */
  private seenNonces = new Map<string, number>()
  private timers: (() => void)[] = []
  private seekingSince = performance.now()
  /**
   * Since when this peer has been cut off: no open link, though it was linked before (or knows
   * members). Null while linked, and for the first peer of an empty lobby.
   */
  private isolatedSince: number | null = null
  /** Whether this peer ever had an open mesh link. */
  private everLinked = false
  private publishing: Promise<void> = Promise.resolve()
  /** Owner decisions, applied one at a time so each builds on the one before. */
  private authQueue: Promise<void> = Promise.resolve()
  private publishQueued = false
  private left = false

  constructor(private opts: MeshOptions<C>) {
    this.selfId = opts.identity.id
    this.ownerId = opts.ownerId
    const now = Date.now()
    this.self = {
      type: 'rec',
      id: this.selfId,
      name: opts.name,
      joinedAt: now,
      version: now,
      heartbeat: now,
      capacityKbps: null,
      offers: {},
      subs: [],
      unreachable: [],
      rtt: {},
      channels: [],
    }
    // Without a factory, C is MeshConn (the type parameter's default).
    this.connect = opts.connect ?? (((ice, id) => new MeshConn(ice, id)) as ConnFactory as ConnFactory<C>)
    const rendezvousOpts: RendezvousOptions<C> = {
      joinCode: opts.joinCode,
      identity: opts.identity,
      trackers: opts.trackers,
      iceServers: opts.iceServers,
      connect: this.connect,
    }
    this.rendezvous = opts.rendezvous ? opts.rendezvous(rendezvousOpts) : new Rendezvous(rendezvousOpts)
    this.rendezvous.onConnection = (conn) => this.adopt(conn, true)
    this.rendezvous.onTrackerStatus = (c) => {
      this.trackersConnected = c
      this.onChange()
    }
    this.rendezvous.shouldAnswer = (id) => this.shouldAnswerDoor(id)
    this.rendezvous.admit = (id) => !this.offline && !this.isBlocked(id) && !this.isBannedPeer(id)
    const connectLane = opts.connectLane ?? ((ice, id, i) => new Lane(ice, id, i))
    this.lanes = new Lanes({
      selfId: this.selfId,
      iceServers: opts.iceServers,
      wanted: clampLanes(opts.lanes),
      connect: connectLane,
      onMedia: (data, from) => this.onMedia(data, from),
      onBufferLow: () => this.onBufferLow(),
      onChange: () => this.onChange(),
    })
  }

  async start(): Promise<void> {
    // The owner keeps its decisions across reloads.
    if (this.selfId === this.ownerId) {
      const saved = this.storage.getItem(this.authStoreKey)
      try {
        if (saved) await this.acceptAuth(JSON.parse(saved) as Envelope)
      } catch {
        // corrupt entry: start without it
      }
    }
    await this.rendezvous.start()
    await this.publish()
    this.rendezvous.setSeeking(true)
    this.updateDoorDuty()
    this.timers.push(every(TICK_MS, () => this.tick()))
    this.timers.push(every(HEARTBEAT_MS, () => void this.publish()))
    this.timers.push(every(DIGEST_MS, () => this.exchangeDigest()))
    this.timers.push(every(RTT_SAMPLE_MS, () => this.sampleRtts()))
  }

  get record(): MemberRecord {
    return this.self
  }

  get isDoor(): boolean {
    return this.rendezvous.isDoor
  }

  /** Live members other than this peer. */
  members(): MemberRecord[] {
    return this.store
      .all()
      .map((s) => s.rec)
      .filter((r) => r.id !== this.selfId)
  }

  member(id: string): MemberRecord | undefined {
    return id === this.selfId ? this.self : this.store.get(id)?.rec
  }

  get memberCount(): number {
    return this.members().length + 1
  }

  linkStatus(id: string): LinkStatus {
    const c = this.conns.get(id)
    if (c?.isOpen) return 'open'
    if (c) return 'connecting'
    if (this.self.unreachable.includes(id) || this.store.get(id)?.rec.unreachable.includes(this.selfId)) return 'unreachable'
    return 'none'
  }

  /** Open links (ctl and media channels both open: what linkFor hands out). */
  private openConns(): C[] {
    return [...this.conns.values()].filter((c) => c.isOpen)
  }

  /** Links still connecting. */
  private get connectingCount(): number {
    let n = 0
    for (const c of this.conns.values()) if (!c.isOpen) n++
    return n
  }

  /**
   * Peer ids of open links, for this peer's record. By state rather than isOpen on purpose: a
   * real link's media channel can open a moment after its ctl channel, and the record published
   * from onOpen should already list the link.
   */
  private openLinkIds(): string[] {
    return [...this.conns.values()].filter((c) => c.state === 'open').map((c) => c.remoteId)
  }

  /**
   * Whether two peers have an open mesh link, as far as gossip tells (unknown counts as linked,
   * since the mesh is full unless a pair failed).
   */
  linked(a: string, b: string): boolean {
    if (a === this.selfId) return !!this.linkFor(b)
    if (b === this.selfId) return !!this.linkFor(a)
    const la = this.member(a)?.links
    const lb = this.member(b)?.links
    if (la && !la.includes(b)) return false
    if (lb && !lb.includes(a)) return false
    return true
  }

  /** The open link to a peer, if any. */
  linkFor(id: string): C | undefined {
    const c = this.conns.get(id)
    return c?.isOpen ? c : undefined
  }

  /**
   * The connection for the `index`-th tree sent to `id` (relay/relayNode.ts ranks them): one of
   * the pair's media lanes when open, else the mesh link itself (see lanes.ts). Undefined without
   * an open mesh link.
   */
  connFor(id: string, index: number): PairConn | undefined {
    const c = this.linkFor(id)
    return c && this.lanes.linkFor(c, index)
  }

  /** Open connections to `id`: the mesh link (lane 0) and each open media lane, by lane index. */
  connectionsOf(id: string): { lane: number; conn: PairConn }[] {
    const c = this.linkFor(id)
    return c ? this.lanes.connections(c) : []
  }

  /** Open connections to `id` (the mesh link plus open lanes; 0 without a mesh link). */
  laneCount(id: string): number {
    return this.connectionsOf(id).length
  }

  /** Whether the direct link to `id` is missing or its pings go unanswered. */
  isSuspected(id: string): boolean {
    const c = this.conns.get(id)
    if (!c) return true
    return linkSuspected({ open: c.isOpen, pingSentAt: c.pingSentAt, lastPongAt: c.lastHeardAt }, performance.now(), SUSPECT_MS)
  }

  /** Whether two peers' mesh link is known to have failed (from either side's record). */
  unreachablePair(a: string, b: string): boolean {
    return !!this.member(a)?.unreachable.includes(b) || !!this.member(b)?.unreachable.includes(a)
  }

  sendApp(to: string, m: unknown): boolean {
    return this.conns.get(to)?.sendCtl({ t: 'app', m }) ?? false
  }

  private get authStoreKey(): string {
    return `p2pss:auth:${this.opts.joinCode}`
  }

  private get storage(): KeyValueStore {
    return this.opts.storage ?? localStore
  }

  /** A peer's public key: from its signed record (or this peer's own). */
  pubKeyOf(id: string): string | undefined {
    return id === this.selfId ? this.opts.identity.pubKey : this.store.get(id)?.env.k
  }

  isBannedPeer(id: string): boolean {
    return this.bannedIds.has(id) || isBanned(this.auth, this.pubKeyOf(id))
  }

  /** Owner only: applies a change to the lobby's decisions, signs it and gossips it. */
  updateAuth(change: (doc: AuthDoc) => AuthDoc): Promise<void> {
    if (this.selfId !== this.ownerId) return Promise.reject(new Error('only the owner decides'))
    // Queued: two decisions made at once must not both start from the same document (the later
    // one would undo the earlier).
    const run = this.authQueue.then(async () => {
      const doc = change(this.auth)
      if (doc === this.auth) return
      const env = await seal(this.opts.identity, doc)
      await this.acceptAuth(env)
    })
    // A failed change must not stall the ones after it.
    this.authQueue = run.catch(() => {})
    return run
  }

  private async acceptAuth(env: Envelope): Promise<void> {
    const opened = await open<AuthDoc>(env, 'auth')
    // Only the key pinned in the join code decides.
    if (!opened || opened.author !== this.ownerId) return
    const bannedIds = new Set(await Promise.all(opened.body.banned.map((k) => peerIdOf(k))))
    // Checked and applied after the last await: of two documents in flight, the newer one wins
    // whichever finishes first.
    if (opened.body.version <= this.auth.version) return
    this.auth = opened.body
    this.authEnv = env
    this.bannedIds = bannedIds
    if (this.selfId === this.ownerId) this.storage.setItem(this.authStoreKey, JSON.stringify(env))
    for (const c of this.conns.values()) c.sendCtl({ t: 'auth', env })
    // Kicked peers: close our links to them, once the news had time to reach them.
    after(KICK_CLOSE_DELAY_MS, () => {
      for (const c of [...this.conns.values()]) if (this.isBannedPeer(c.remoteId)) c.close()
    })
    this.onAuth(this.auth)
    this.onChange()
  }

  /** Updates this peer's record and gossips it (coalesced). */
  updateRecord(patch: Partial<Omit<MemberRecord, 'type' | 'id' | 'version' | 'heartbeat'>>): void {
    Object.assign(this.self, patch)
    void this.publish()
  }

  sendChat(text: string): boolean {
    const trimmed = text.trim().slice(0, CHAT_MAX_LEN)
    if (!trimmed || !this.chatSent.take(performance.now())) return false
    const body: ChatBody = { type: 'chat', id: crypto.randomUUID(), from: this.selfId, name: this.self.name, text: trimmed, at: Date.now() }
    void seal(this.opts.identity, body).then((env) => {
      this.storeChat(body, env)
      for (const c of this.conns.values()) c.sendCtl({ t: 'chat', env })
    })
    return true
  }

  /**
   * Debug/e2e: behave as if this machine went offline for `ms` (asleep, network down): every link
   * drops and nothing new is accepted, while the page keeps running.
   */
  debugGoOffline(ms: number): void {
    this.offlineUntil = performance.now() + ms
    this.rendezvous.setDoor(false)
    this.rendezvous.setSeeking(false)
    for (const c of [...this.conns.values()]) c.close()
  }
  private offlineUntil = 0
  private get offline(): boolean {
    return performance.now() < this.offlineUntil
  }

  /** Closes the link to a peer (it will be retried if the peer is still a member). */
  resetLink(id: string): void {
    this.conns.get(id)?.close()
  }

  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    this.timers.forEach((cancel) => cancel())
    this.self.left = true
    this.self.version = Math.max(this.self.version + 1, Date.now())
    try {
      const env = await seal(this.opts.identity, this.self)
      for (const c of this.conns.values()) c.sendCtl({ t: 'rec', env })
    } catch {
      // closing anyway
    }
    this.rendezvous.close()
    after(LEAVE_CLOSE_DELAY_MS, () => {
      this.lanes.closeAll()
      for (const c of this.conns.values()) c.close()
      this.conns.clear()
    })
  }

  // --- own record ------------------------------------------------------------------------------

  /** Seals and sends this peer's record to every neighbour. Concurrent calls coalesce. */
  private publish(): Promise<void> {
    if (this.left) return this.publishing
    if (this.publishQueued) return this.publishing
    this.publishQueued = true
    this.publishing = this.publishing.then(async () => {
      this.publishQueued = false
      const now = Date.now()
      this.self.version = Math.max(this.self.version + 1, now)
      this.self.heartbeat = now
      this.self.links = this.openLinkIds()
      this.selfEnv = await seal(this.opts.identity, this.self)
      for (const c of this.conns.values()) if (c.isOpen) c.sendCtl({ t: 'rec', env: this.selfEnv })
    }).catch((err) => {
      // Kept resolved: a rejected chain would skip every later publish (and leave it queued).
      console.warn('mesh publish failed', err)
    })
    return this.publishing
  }

  // --- links -----------------------------------------------------------------------------------

  /** Wires a connection whose remote id is verified (door link or relayed signaling). */
  private adopt(conn: C, viaTracker: boolean): void {
    const id = conn.remoteId
    const prev = this.conns.get(id)
    // Two doors may each answer the other's offer at once. Both sides keep the connection offered
    // by the lower id, so they agree on one.
    if (prev && prev !== conn && prev.state !== 'closed' && prev.state !== 'failed' && prev.offerer && conn.offerer && prev.offerer !== conn.offerer && performance.now() - prev.createdAt < GLARE_WINDOW_MS) {
      const keepPrev = prev.offerer < conn.offerer
      if (keepPrev) {
        conn.close()
        return
      }
    }
    if (prev && prev !== conn) {
      // A fresh connection replaces a stale one (e.g. the remote reloaded).
      if (this.discardConn(prev)) this.onLinkClose(id)
    }
    this.conns.set(id, conn)
    conn.onCtl = (msg) => this.handle(msg as MeshMsg, id, conn)
    conn.onMedia = (data) => this.onMedia(data, id)
    conn.onBufferLow = () => this.onBufferLow()
    conn.onStateChange = (state) => {
      if (state === 'open') {
        this.onOpen(conn, viaTracker)
      } else if (state === 'closed' || state === 'failed') {
        this.onClosed(conn)
      }
    }
    if (conn.state === 'open') this.onOpen(conn, viaTracker)
  }

  private onOpen(conn: C, viaTracker: boolean): void {
    const id = conn.remoteId
    this.joined = true
    this.everLinked = true
    this.retry.delete(id)
    this.detector.heard(id, performance.now())
    if (this.self.unreachable.includes(id)) this.self.unreachable = this.self.unreachable.filter((x) => x !== id)
    this.updateRecord({ links: this.openLinkIds() })
    if (this.selfEnv) conn.sendCtl({ t: 'rec', env: this.selfEnv })
    if (viaTracker) {
      // Door link: hand over everything we know, so the joiner can mesh in.
      conn.sendCtl({ t: 'snapshot', recs: this.store.all().map((s) => s.env), chat: this.chatEnvelopes(), auth: this.authEnv })
      this.rendezvous.setSeeking(false)
    } else if (this.chatLog.length) {
      // Recent chat, so messages sent while this pair was apart still arrive (deduplicated by id).
      conn.sendCtl({ t: 'snapshot', recs: [], chat: this.chatEnvelopes() })
    }
    if (this.authEnv) conn.sendCtl({ t: 'auth', env: this.authEnv })
    conn.sendCtl({ t: 'digest', d: this.digest(), a: this.auth.version })
    // Only now, with the mesh link open (never during the tracker rendezvous): media lanes.
    this.lanes.primaryOpened(conn)
    this.onLinkOpen(id)
    this.onChange()
  }

  private onClosed(conn: C): void {
    const id = conn.remoteId
    this.lanes.primaryClosed(conn)
    if (this.conns.get(id) !== conn) return
    this.conns.delete(id)
    this.pendingOffers.delete(id)
    if (conn.wasOpen) {
      this.updateRecord({ links: this.openLinkIds() })
      this.onLinkClose(id)
      if (this.store.has(id)) this.scheduleRetry(id, RELINK_MS, 0)
    } else if (this.store.has(id)) {
      // ICE was tried and failed: the pair can't connect. Otherwise signaling got lost: retry soon.
      if (conn.haveRemote) this.markUnreachable(id)
      else this.scheduleRetry(id, RELINK_MS)
    }
    this.onChange()
  }

  /**
   * Closes and forgets a connection quietly: unlike onClosed, nothing is retried or marked
   * unreachable. Returns whether it was open (the caller reports the link closed).
   */
  private discardConn(conn: C): boolean {
    const id = conn.remoteId
    const wasOpen = conn.isOpen
    conn.onStateChange = () => {}
    conn.close()
    this.lanes.primaryClosed(conn)
    if (this.conns.get(id) === conn) this.conns.delete(id)
    if (this.pendingOffers.get(id)?.conn === conn) this.pendingOffers.delete(id)
    return wasOpen
  }

  /** Next attempt to link to `id` no sooner than `delayMs` from now (attempts kept unless given). */
  private scheduleRetry(id: string, delayMs: number, attempts = this.retry.get(id)?.attempts ?? 0): void {
    this.retry.set(id, { attempts, at: performance.now() + delayMs })
  }

  private markUnreachable(id: string): void {
    const attempts = (this.retry.get(id)?.attempts ?? 0) + 1
    this.scheduleRetry(id, retryDelayMs(attempts), attempts)
    if (!this.self.unreachable.includes(id)) this.updateRecord({ unreachable: [...this.self.unreachable, id] })
  }

  private isBlocked(id: string): boolean {
    const name = this.store.get(id)?.rec.name
    return !!name && !!this.opts.block?.includes(name)
  }

  private shouldAnswerDoor(id: string): boolean {
    if (this.offline) return false
    if (this.conns.get(id)?.isOpen || this.isBlocked(id)) return false
    // A kicked peer is refused (its key is known from gossip once it was a member).
    if (this.isBannedPeer(id)) return false
    // Joining (an owner coming back to a populated lobby too), or cut off from everyone: answer
    // the first offer.
    const fresh = !this.everLinked && performance.now() - this.seekingSince < ALONE_DOOR_MS * 2
    if (!this.joined || fresh || this.isolatedSince !== null) return this.connectingCount === 0
    // Otherwise a door answers doors of a lower id it has no link to: that merges groups that
    // formed apart, and re-links a pair whose link dropped when no neighbour can relay for it. A
    // pair whose ICE failed waits for its retry backoff, rather than trying every announce.
    const backoff = this.self.unreachable.includes(id) && (this.retry.get(id)?.at ?? 0) > performance.now()
    return this.rendezvous.isDoor && id < this.selfId && !this.conns.has(id) && !backoff
  }

  // --- periodic work ---------------------------------------------------------------------------

  private tick(): void {
    const now = performance.now()
    if (this.offline) {
      for (const c of [...this.conns.values()]) c.close()
      for (const id of this.detector.gone(now)) this.dropMember(id)
      return
    }
    // Liveness pings on idle links.
    for (const c of this.conns.values()) {
      if (!c.isOpen) continue
      if (now - c.lastHeardAt > PING_IDLE_MS && (c.pingSentAt === null || now - c.pingSentAt > SUSPECT_MS * 2)) {
        c.ping(GONE_MS)
          .then(() => this.detector.heard(c.remoteId, performance.now()))
          .catch(() => {}) // unanswered: the failure detector notices the silence
      }
    }
    // Members not heard from (directly or through gossip) are gone.
    for (const id of this.detector.gone(now)) this.dropMember(id)
    const wall = Date.now()
    for (const [n, until] of this.seenNonces) if (wall > until) this.seenNonces.delete(n)
    this.connectMissing(now)
    this.updateDoorDuty()
  }

  private updateDoorDuty(): void {
    if (this.left) return
    const now = performance.now()
    let door = doorPeers([...this.members(), this.self], this.ownerId).has(this.selfId)
    // Nobody answered: this peer is alone, so it opens the lobby itself.
    if (!this.joined && this.store.ids().length === 0) {
      door = this.selfId === this.ownerId || now - this.seekingSince > ALONE_DOOR_MS
      if (door) this.joined = true
    }
    this.rendezvous.setDoor(door)
    const linked = this.openConns().length > 0
    // A peer that dropped everyone (asleep, offline) has no members left but must look again.
    if (linked || (this.store.ids().length === 0 && !this.everLinked)) this.isolatedSince = null
    else if (this.isolatedSince === null) this.isolatedSince = now
    const isolated = this.isolatedSince !== null && now - this.isolatedSince > ISOLATED_MS
    this.rendezvous.setSeeking(!this.joined || isolated)
  }

  /** Opens links to members we aren't connected to, at most CONNECT_BATCH at a time. */
  private connectMissing(now: number): void {
    if (!this.joined) return
    let connecting = this.connectingCount
    for (const rec of this.members()) {
      if (connecting >= CONNECT_BATCH) break
      const id = rec.id
      if (this.conns.has(id) || this.isBannedPeer(id)) continue
      const r = this.retry.get(id)
      if (r && now < r.at) continue
      connecting++
      this.scheduleRetry(id, CONNECT_ATTEMPT_MS)
      void this.initiate(id)
    }
  }

  private async initiate(id: string): Promise<void> {
    if (this.isBlocked(id)) {
      // Debug: behave as if ICE failed for this pair.
      this.markUnreachable(id)
      return
    }
    const nonce = crypto.randomUUID()
    if (this.selfId > id) {
      // The lower id offers: ask it to.
      await this.sendSig(id, { kind: 'knock', nonce })
      return
    }
    const conn = this.connect(this.opts.iceServers, id)
    conn.offerer = this.selfId
    this.pendingOffers.set(id, { conn, nonce })
    this.adopt(conn, false)
    try {
      const sdp = await conn.createOffer()
      if (conn.state !== 'connecting') return
      await this.sendSig(id, { kind: 'offer', sdp, nonce })
      // No answer within the deadline: signaling got lost, try again.
      conn.armTimeout()
    } catch (err) {
      console.warn('mesh offer failed', err)
      conn.close()
    }
  }

  /** Signs a signaling message and routes it through up to two neighbours (the door first). */
  private async sendSig(to: string, msg: Pick<SigBody, 'kind' | 'sdp' | 'nonce'>): Promise<void> {
    const env = await seal<SigBody>(this.opts.identity, { type: 'sig', from: this.selfId, to, at: Date.now(), ...msg }, Infinity)
    const direct = this.conns.get(to)
    if (direct?.isOpen) {
      direct.sendCtl({ t: 'sig', to, env })
      return
    }
    const relays = [...this.conns.values()]
      .filter((c) => c.isOpen && c.remoteId !== to && !this.unreachablePair(c.remoteId, to))
      .sort((a, b) => this.relayRank(a.remoteId, to) - this.relayRank(b.remoteId, to) || this.joinedAtOf(a.remoteId) - this.joinedAtOf(b.remoteId))
      .slice(0, 2)
    for (const r of relays) r.sendCtl({ t: 'sig', to, env })
  }

  /**
   * How good a neighbour is as a relay towards `to` (lower is better): first those gossip says are
   * linked to it, then the owner (a door, linked to everyone it admitted), then older members.
   */
  private relayRank(id: string, to: string): number {
    const target = this.store.get(to)?.rec
    const relay = this.store.get(id)?.rec
    if (target?.links?.includes(id) || relay?.links?.includes(to)) return 0
    if (id === this.ownerId) return 1
    return 2
  }

  /** When a member joined (unknown ones sort last among relays). */
  private joinedAtOf(id: string): number {
    return this.store.get(id)?.rec.joinedAt ?? Infinity
  }

  private async onSig(env: Envelope, to: string, from: string): Promise<void> {
    if (to !== this.selfId) {
      // Relay one hop to the addressee.
      if (from !== to) this.conns.get(to)?.sendCtl({ t: 'sig', to, env })
      return
    }
    const opened = await open<SigBody>(env, 'sig')
    if (!opened) return
    const b = opened.body
    if (b.from !== opened.author || b.to !== this.selfId || Math.abs(Date.now() - b.at) > SIG_MAX_AGE_MS) return
    const key = `${b.from}:${b.kind}:${b.nonce}`
    if (this.seenNonces.has(key)) return
    // Kept for as long as the message's `at` passes the age check, so it can't be replayed.
    this.seenNonces.set(key, Math.max(Date.now(), b.at) + SIG_MAX_AGE_MS)
    if (this.isBlocked(b.from) || this.isBannedPeer(b.from) || this.left || this.offline) return

    if (b.kind === 'knock') {
      const cur = this.conns.get(b.from)
      // Our own offer may have crossed the knock: keep it rather than restart ICE gathering.
      const offering = !!cur && this.pendingOffers.get(b.from)?.conn === cur && performance.now() - cur.createdAt < KNOCK_KEEP_OFFER_MS
      if (this.selfId < b.from && !cur?.isOpen && !offering) {
        cur?.close()
        this.scheduleRetry(b.from, CONNECT_ATTEMPT_MS)
        void this.initiate(b.from)
      }
    } else if (b.kind === 'offer' && b.sdp) {
      if (b.from > this.selfId) return // only the lower id offers
      const prev = this.conns.get(b.from)
      if (prev?.isOpen && performance.now() - prev.createdAt < FRESH_LINK_MS) return
      const conn = this.connect(this.opts.iceServers, b.from)
      conn.offerer = b.from
      this.adopt(conn, false)
      try {
        const sdp = await conn.acceptOffer(b.sdp)
        await this.sendSig(b.from, { kind: 'answer', sdp, nonce: b.nonce })
      } catch (err) {
        console.warn('mesh answer failed', err)
        conn.close()
      }
    } else if (b.kind === 'answer' && b.sdp) {
      const p = this.pendingOffers.get(b.from)
      if (!p || p.nonce !== b.nonce) return
      this.pendingOffers.delete(b.from)
      try {
        await p.conn.acceptAnswer(b.sdp)
      } catch {
        // a bad answer SDP: drop the attempt (connectMissing retries)
        p.conn.close()
      }
    }
  }

  // --- gossip ------------------------------------------------------------------------------------

  private digest(): Digest {
    const d = this.store.digest()
    d[this.selfId] = this.self.version
    return d
  }

  private exchangeDigest(): void {
    const open = this.openConns()
    if (!open.length) return
    open[Math.floor(Math.random() * open.length)].sendCtl({ t: 'digest', d: this.digest(), a: this.auth.version })
  }

  private async acceptRecord(env: Envelope): Promise<void> {
    const opened = await open<MemberRecord>(env, 'rec')
    // Malformed records are dropped here, so they are neither stored nor forwarded.
    if (!opened || !isMemberRecord(opened.body) || opened.body.id !== opened.author) return
    const rec = opened.body
    if (rec.id === this.selfId) {
      // A copy from a previous session of ours: stay ahead of it.
      if (rec.version >= this.self.version && !this.left) {
        this.self.version = rec.version
        void this.publish()
      }
      return
    }
    const known = this.store.has(rec.id)
    if (!this.store.accept(rec, env, performance.now())) return
    if (rec.left) {
      this.dropMember(rec.id)
      return
    }
    this.detector.heard(rec.id, performance.now())
    if (!known) {
      // Debug blocking by name: a link opened before the name was known is dropped now.
      const c = this.conns.get(rec.id)
      if (c && this.isBlocked(rec.id)) {
        const wasOpen = this.discardConn(c)
        this.markUnreachable(rec.id) // republishes the record, without the link
        if (wasOpen) this.onLinkClose(rec.id)
      }
      this.onMemberJoin(rec.id)
    }
    this.onRecord(rec)
    this.onChange()
  }

  private dropMember(id: string): void {
    const had = this.store.has(id)
    this.store.remove(id)
    this.detector.forget(id)
    this.retry.delete(id)
    this.conns.get(id)?.close()
    if (this.self.unreachable.includes(id)) this.updateRecord({ unreachable: this.self.unreachable.filter((x) => x !== id) })
    if (this.self.rtt[id] !== undefined) {
      const rtt = { ...this.self.rtt }
      delete rtt[id]
      this.self.rtt = rtt
    }
    if (had) {
      this.onMemberLeave(id)
      this.onChange()
    }
  }

  /** Gossips the RTT to each linked peer: the path's (pathRttMs), else the ctl pings'. */
  private sampleRtts(): void {
    const rtt: Record<string, number> = {}
    for (const c of this.conns.values()) {
      if (!c.isOpen) continue
      const ms = this.pathRttMs(c.remoteId) ?? c.rttMs
      if (ms !== null) rtt[c.remoteId] = Math.round(ms)
    }
    this.updateRecord({ rtt })
  }

  // --- chat ----------------------------------------------------------------------------------------

  /** `history`: part of a link's initial snapshot, so not rate limited by arrival time. */
  private async onChatEnv(env: Envelope, from: string, history = false): Promise<void> {
    const opened = await open<ChatBody>(env, 'chat')
    if (!opened) return
    const b = opened.body
    if (b.from !== opened.author || typeof b.id !== 'string' || typeof b.name !== 'string' || typeof b.at !== 'number') return
    if (typeof b.text !== 'string' || b.text.length > CHAT_MAX_LEN) return
    if (!Number.isFinite(b.at) || b.at > Date.now() + CHAT_MAX_FUTURE_MS) return
    if (this.isBannedPeer(b.from)) return
    if (this.chat.some((m) => m.id === b.id)) return
    if (!history) {
      // Senders are rate limited by everyone, so a flooding member can't drown the chat.
      let limit = this.chatByAuthor.get(b.from)
      if (!limit) this.chatByAuthor.set(b.from, (limit = new RateWindow(CHAT_RATE)))
      if (!limit.take(performance.now())) return
    }
    // One older than the whole log is dropped (and not handed on).
    if (!this.storeChat(b, env)) return
    // Forward to neighbours the sender can't reach directly (as either side of the pair says).
    for (const c of this.openConns()) {
      if (c.remoteId !== from && c.remoteId !== b.from && this.unreachablePair(b.from, c.remoteId)) c.sendCtl({ t: 'chat', env })
    }
  }

  /** Adds a message to the log; false if it is older than all CHAT_KEEP kept ones (so not kept). */
  private storeChat(b: ChatBody, env: Envelope): boolean {
    const entry = { m: { id: b.id, from: b.from, name: b.name, text: b.text, at: b.at }, env }
    // Stable sort: among equal times, the newcomer stays last (and so is kept).
    this.chatLog = [...this.chatLog, entry].sort((x, y) => x.m.at - y.m.at).slice(-CHAT_KEEP)
    this.chat = this.chatLog.map((e) => e.m)
    if (!this.chatLog.includes(entry)) return false
    this.onChat(entry.m)
    this.onChange()
    return true
  }

  private chatEnvelopes(): Envelope[] {
    return this.chatLog.map((e) => e.env)
  }

  // --- dispatch ----------------------------------------------------------------------------------

  private handle(msg: MeshMsg, from: string, conn: C): void {
    if (this.conns.get(from) !== conn) return
    if (msg.t !== 'auth' && this.isBannedPeer(from)) {
      // The owner's decisions are signed, so they are taken from anyone.
      if (msg.t === 'snapshot' && msg.auth) void this.acceptAuth(msg.auth)
      conn.close()
      return
    }
    this.detector.heard(from, performance.now())
    switch (msg.t) {
      case 'rec':
        void this.acceptRecord(msg.env)
        break
      case 'recs':
        for (const env of msg.envs ?? []) void this.acceptRecord(env)
        break
      case 'snapshot': {
        if (msg.auth) void this.acceptAuth(msg.auth)
        for (const env of msg.recs ?? []) void this.acceptRecord(env)
        // History is exempt from the chat rate limit (it was sent over time), but only in the one
        // snapshot a link starts with, and only as much as anyone keeps.
        const history = !this.snapshotted.has(conn)
        this.snapshotted.add(conn)
        for (const env of (msg.chat ?? []).slice(-CHAT_KEEP)) void this.onChatEnv(env, from, history)
        break
      }
      case 'auth':
        void this.acceptAuth(msg.env)
        break
      case 'digest': {
        // A digest is unsigned, so it is no evidence that anyone is alive: the records pulled in
        // reply are (acceptRecord marks their authors heard).
        const { pull, push } = this.store.compare(msg.d ?? {})
        const ownNewer = (msg.d?.[this.selfId] ?? -Infinity) < this.self.version
        const envs = [...push, ...(ownNewer && this.selfEnv ? [this.selfEnv] : [])]
        if (envs.length) conn.sendCtl({ t: 'recs', envs })
        const want = pull.filter((id) => id !== this.selfId)
        if (want.length) conn.sendCtl({ t: 'pull', ids: want })
        if (this.authEnv && (msg.a ?? 0) < this.auth.version) conn.sendCtl({ t: 'auth', env: this.authEnv })
        break
      }
      case 'pull': {
        const envs = (msg.ids ?? []).map((id) => (id === this.selfId ? this.selfEnv : this.store.get(id)?.env)).filter((e): e is Envelope => !!e)
        if (envs.length) conn.sendCtl({ t: 'recs', envs })
        break
      }
      case 'sig':
        void this.onSig(msg.env, msg.to, from)
        break
      case 'chat':
        void this.onChatEnv(msg.env, from)
        break
      case 'app':
        this.onApp(msg.m, from)
        break
      case 'lane-offer':
      case 'lane-answer':
      case 'lane-close':
        if (isLaneMsg(msg)) this.lanes.handle(msg, conn)
        break
    }
  }
}
