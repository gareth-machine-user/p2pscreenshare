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
import { Rendezvous } from '../net/bootstrap'
import { emptyAuth, isBanned, type AuthDoc } from './auth'
import { open, seal, type Envelope, type Typed } from './envelope'
import type { PeerIdentity } from './identity'
import { MeshConn } from './meshConn'
import { doorPeers, FailureDetector, linkSuspected, RecordStore, retryDelayMs, type Digest, type MemberRecord } from './records'

const HEARTBEAT_MS = 2000
const DIGEST_MS = 2000
const RTT_SAMPLE_MS = 10_000
const PING_IDLE_MS = 1000
export const SUSPECT_MS = 1500
export const GONE_MS = 6000
const CONNECT_BATCH = 8
/** Time for a relayed offer/answer exchange plus ICE before the attempt counts as failed. */
const CONNECT_ATTEMPT_MS = 15_000
/** A link that dropped after being open is retried this soon (the peer may still be around). */
const RELINK_MS = 2000
/** Seeking with no offer for this long while knowing no members: this peer starts the lobby. */
const ALONE_DOOR_MS = 5000
/** A member with no open links for this long goes back to the tracker to find the lobby again. */
const ISOLATED_MS = 3000
const SIG_MAX_AGE_MS = 120_000
const CHAT_KEEP = 50
const CHAT_MAX_LEN = 500
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

export interface MeshOptions {
  joinCode: string
  identity: PeerIdentity
  ownerId: string
  name: string
  trackers?: string[]
  iceServers: RTCIceServer[]
  /** Debug: refuse mesh links with members of these names, as if ICE failed. */
  block?: string[]
}

export type LinkStatus = 'open' | 'connecting' | 'unreachable' | 'none'

export class Mesh {
  readonly selfId: string
  readonly ownerId: string
  readonly store = new RecordStore()
  /** Open or connecting links, by remote peer id. */
  readonly conns = new Map<string, MeshConn>()
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
  onBinary: (data: Uint8Array, from: string) => void = () => {}
  onBufferLow: () => void = () => {}
  onChat: (m: ChatMessage) => void = () => {}
  /** The owner's decisions changed. */
  onAuth: (doc: AuthDoc) => void = () => {}
  onChange: () => void = () => {}

  private self: MemberRecord
  private selfEnv: Envelope | null = null
  private authEnv: Envelope | null = null
  private rendezvous: Rendezvous
  private chatEnvs: Envelope[] = []
  private chatSent: number[] = []
  private chatByAuthor = new Map<string, number[]>()
  /** Per remote: failed attempts and when to try again. */
  private retry = new Map<string, { attempts: number; at: number }>()
  /** Outgoing offers awaiting an answer, by remote id. */
  private pendingOffers = new Map<string, { conn: MeshConn; nonce: string }>()
  private seenNonces = new Map<string, number>()
  private timers: ReturnType<typeof setInterval>[] = []
  private seekingSince = performance.now()
  /** Since when this peer has had members but no open link (null while linked). */
  private isolatedSince: number | null = null
  private publishing: Promise<void> = Promise.resolve()
  private publishQueued = false
  private left = false

  constructor(private opts: MeshOptions) {
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
    this.rendezvous = new Rendezvous({
      joinCode: opts.joinCode,
      identity: opts.identity,
      trackers: opts.trackers,
      iceServers: opts.iceServers,
    })
    this.rendezvous.onConnection = (conn) => this.adopt(conn, true)
    this.rendezvous.onTrackerStatus = (c) => {
      this.trackersConnected = c
      this.onChange()
    }
    this.rendezvous.shouldAnswer = (id) => this.shouldAnswerDoor(id)
    this.rendezvous.admit = (id) => !this.isBlocked(id) && !this.isBannedPeer(id)
  }

  async start(): Promise<void> {
    // The owner keeps its decisions across reloads.
    if (this.selfId === this.ownerId) {
      try {
        const saved = localStorage.getItem(this.authStoreKey)
        if (saved) await this.acceptAuth(JSON.parse(saved) as Envelope)
      } catch {
        // nothing saved, or storage unavailable
      }
    }
    await this.rendezvous.start()
    await this.publish()
    this.rendezvous.setSeeking(true)
    this.updateDoorDuty()
    this.timers.push(setInterval(() => this.tick(), 250))
    this.timers.push(setInterval(() => void this.publish(), HEARTBEAT_MS))
    this.timers.push(setInterval(() => this.exchangeDigest(), DIGEST_MS))
    this.timers.push(setInterval(() => void this.sampleRtts(), RTT_SAMPLE_MS))
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
  linkFor(id: string): MeshConn | undefined {
    const c = this.conns.get(id)
    return c?.isOpen ? c : undefined
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

  /** A peer's public key: from its signed record (or this peer's own). */
  pubKeyOf(id: string): string | undefined {
    return id === this.selfId ? this.opts.identity.pubKey : this.store.get(id)?.env.k
  }

  isBannedPeer(id: string): boolean {
    return isBanned(this.auth, this.pubKeyOf(id))
  }

  /** Owner only: applies a change to the lobby's decisions, signs it and gossips it. */
  async updateAuth(change: (doc: AuthDoc) => AuthDoc): Promise<void> {
    if (this.selfId !== this.ownerId) throw new Error('only the owner decides')
    const doc = change(this.auth)
    if (doc === this.auth) return
    const env = await seal(this.opts.identity, doc)
    await this.acceptAuth(env)
  }

  private async acceptAuth(env: Envelope): Promise<void> {
    const opened = await open<AuthDoc>(env, 'auth')
    // Only the key pinned in the join code decides.
    if (!opened || opened.author !== this.ownerId || opened.body.version <= this.auth.version) return
    this.auth = opened.body
    this.authEnv = env
    if (this.selfId === this.ownerId) {
      try {
        localStorage.setItem(this.authStoreKey, JSON.stringify(env))
      } catch {
        // storage unavailable
      }
    }
    for (const c of this.conns.values()) c.sendCtl({ t: 'auth', env })
    // Kicked peers: close our links to them.
    for (const c of [...this.conns.values()]) if (this.isBannedPeer(c.remoteId)) c.close()
    this.onAuth(this.auth)
    this.onChange()
  }

  /** Updates this peer's record and gossips it (coalesced). */
  updateRecord(patch: Partial<Omit<MemberRecord, 'type' | 'id' | 'version' | 'heartbeat'>>): void {
    Object.assign(this.self, patch)
    void this.publish()
  }

  sendChat(text: string): boolean {
    const now = performance.now()
    this.chatSent = this.chatSent.filter((t) => now - t < CHAT_RATE.perMs)
    const trimmed = text.trim().slice(0, CHAT_MAX_LEN)
    if (!trimmed || this.chatSent.length >= CHAT_RATE.count) return false
    this.chatSent.push(now)
    const body: ChatBody = { type: 'chat', id: crypto.randomUUID(), from: this.selfId, name: this.self.name, text: trimmed, at: Date.now() }
    void seal(this.opts.identity, body).then((env) => {
      this.storeChat(body, env)
      for (const c of this.conns.values()) c.sendCtl({ t: 'chat', env })
    })
    return true
  }

  /** Closes the link to a peer (it will be retried if the peer is still a member). */
  resetLink(id: string): void {
    this.conns.get(id)?.close()
  }

  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    this.timers.forEach(clearInterval)
    this.self.left = true
    this.self.version = Math.max(this.self.version + 1, Date.now())
    try {
      const env = await seal(this.opts.identity, this.self)
      for (const c of this.conns.values()) c.sendCtl({ t: 'rec', env })
    } catch {
      // closing anyway
    }
    this.rendezvous.close()
    setTimeout(() => {
      for (const c of this.conns.values()) c.close()
      this.conns.clear()
    }, 100)
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
    })
    return this.publishing
  }

  // --- links -----------------------------------------------------------------------------------

  /** Wires a connection whose remote id is verified (door link or relayed signaling). */
  private adopt(conn: MeshConn, viaTracker: boolean): void {
    const id = conn.remoteId
    const prev = this.conns.get(id)
    if (prev && prev !== conn) {
      // A fresh connection replaces a stale one (e.g. the remote reloaded).
      const wasOpen = prev.isOpen
      prev.onStateChange = () => {}
      prev.close()
      this.pendingOffers.delete(id)
      if (wasOpen) this.onLinkClose(id)
    }
    this.conns.set(id, conn)
    conn.onCtl = (msg) => this.handle(msg as MeshMsg, id, conn)
    conn.onMedia = (data) => this.onMedia(data, id)
    conn.onBin = (data) => this.onBinary(data, id)
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

  private onOpen(conn: MeshConn, viaTracker: boolean): void {
    const id = conn.remoteId
    this.joined = true
    this.retry.delete(id)
    this.detector.heard(id, performance.now())
    if (this.self.unreachable.includes(id)) this.self.unreachable = this.self.unreachable.filter((x) => x !== id)
    this.updateRecord({ links: this.openLinkIds() })
    if (this.selfEnv) conn.sendCtl({ t: 'rec', env: this.selfEnv })
    if (viaTracker) {
      // Door link: hand over everything we know, so the joiner can mesh in.
      conn.sendCtl({ t: 'snapshot', recs: this.store.all().map((s) => s.env), chat: this.chatEnvs, auth: this.authEnv })
      this.rendezvous.setSeeking(false)
    } else if (this.chatEnvs.length) {
      // Recent chat, so messages sent while this pair was apart still arrive (deduplicated by id).
      conn.sendCtl({ t: 'snapshot', recs: [], chat: this.chatEnvs })
    }
    if (this.authEnv) conn.sendCtl({ t: 'auth', env: this.authEnv })
    conn.sendCtl({ t: 'digest', d: this.digest(), a: this.auth.version })
    this.onLinkOpen(id)
    this.onChange()
  }

  private onClosed(conn: MeshConn): void {
    const id = conn.remoteId
    if (this.conns.get(id) !== conn) return
    this.conns.delete(id)
    this.pendingOffers.delete(id)
    if (conn.wasOpen) {
      this.updateRecord({ links: this.openLinkIds() })
      this.onLinkClose(id)
      if (this.store.has(id)) this.retry.set(id, { attempts: 0, at: performance.now() + RELINK_MS })
    } else if (this.store.has(id)) {
      // ICE was tried and failed: the pair can't connect. Otherwise signaling got lost: retry soon.
      if (conn.haveRemote) this.markUnreachable(id)
      else this.retry.set(id, { attempts: this.retry.get(id)?.attempts ?? 0, at: performance.now() + RELINK_MS })
    }
    this.onChange()
  }

  private markUnreachable(id: string): void {
    const r = this.retry.get(id)
    const attempts = (r?.attempts ?? 0) + 1
    this.retry.set(id, { attempts, at: performance.now() + retryDelayMs(attempts) })
    if (!this.self.unreachable.includes(id)) this.updateRecord({ unreachable: [...this.self.unreachable, id] })
  }

  private isBlocked(id: string): boolean {
    const name = this.store.get(id)?.rec.name
    return !!name && !!this.opts.block?.includes(name)
  }

  private shouldAnswerDoor(id: string): boolean {
    if (this.conns.get(id)?.isOpen || this.isBlocked(id)) return false
    // A kicked peer is refused (its key is known from gossip once it was a member).
    if (this.isBannedPeer(id)) return false
    // Joining, or cut off from everyone: answer the first offer.
    if (!this.joined || this.isolatedSince !== null) return this.pendingDoorAnswers === 0
    // Otherwise a door answers doors of a lower id it has no link to: that merges groups that
    // formed apart, and re-links a pair whose link dropped when no neighbour can relay for it.
    return this.rendezvous.isDoor && id < this.selfId && !this.conns.has(id)
  }

  private get pendingDoorAnswers(): number {
    let n = 0
    for (const c of this.conns.values()) if (!c.isOpen) n++
    return n
  }

  // --- periodic work ---------------------------------------------------------------------------

  private tick(): void {
    const now = performance.now()
    // Liveness pings on idle links.
    for (const c of this.conns.values()) {
      if (!c.isOpen) continue
      if (now - c.lastHeardAt > PING_IDLE_MS && (c.pingSentAt === null || now - c.pingSentAt > SUSPECT_MS * 2)) {
        c.ping(GONE_MS)
          .then(() => this.detector.heard(c.remoteId, performance.now()))
          .catch(() => {})
      }
    }
    // Members not heard from (directly or through gossip) are gone.
    for (const id of this.detector.gone(now)) this.dropMember(id)
    for (const [n, t] of this.seenNonces) if (now - t > SIG_MAX_AGE_MS) this.seenNonces.delete(n)
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
    const linked = [...this.conns.values()].some((c) => c.isOpen)
    if (linked || this.store.ids().length === 0) this.isolatedSince = null
    else if (this.isolatedSince === null) this.isolatedSince = now
    const isolated = this.isolatedSince !== null && now - this.isolatedSince > ISOLATED_MS
    this.rendezvous.setSeeking(!this.joined || isolated)
  }

  /** Opens links to members we aren't connected to, at most CONNECT_BATCH at a time. */
  private connectMissing(now: number): void {
    if (!this.joined) return
    let connecting = 0
    for (const c of this.conns.values()) if (!c.isOpen) connecting++
    for (const rec of this.members()) {
      if (connecting >= CONNECT_BATCH) break
      const id = rec.id
      if (this.conns.has(id) || this.isBannedPeer(id)) continue
      const r = this.retry.get(id)
      if (r && now < r.at) continue
      connecting++
      this.retry.set(id, { attempts: r?.attempts ?? 0, at: now + CONNECT_ATTEMPT_MS })
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
    const conn = new MeshConn(this.opts.iceServers, id)
    this.pendingOffers.set(id, { conn, nonce })
    this.adopt(conn, false)
    try {
      const sdp = await conn.createOffer()
      if (conn.state !== 'connecting') return
      await this.sendSig(id, { kind: 'offer', sdp, nonce })
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
      .sort((a, b) => this.relayRank(a.remoteId, to) - this.relayRank(b.remoteId, to))
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
    return 2 + (relay ? 1 - 1 / (1 + Math.max(0, Date.now() - relay.joinedAt)) : 1)
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
    this.seenNonces.set(key, performance.now())
    if (this.isBlocked(b.from) || this.isBannedPeer(b.from) || this.left) return

    if (b.kind === 'knock') {
      if (this.selfId < b.from && !this.conns.get(b.from)?.isOpen) {
        this.conns.get(b.from)?.close()
        this.retry.set(b.from, { attempts: this.retry.get(b.from)?.attempts ?? 0, at: performance.now() + CONNECT_ATTEMPT_MS })
        void this.initiate(b.from)
      }
    } else if (b.kind === 'offer' && b.sdp) {
      if (b.from > this.selfId) return // only the lower id offers
      const prev = this.conns.get(b.from)
      if (prev?.isOpen && performance.now() - prev.createdAt < 2000) return
      const conn = new MeshConn(this.opts.iceServers, b.from)
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
    const open = [...this.conns.values()].filter((c) => c.isOpen)
    if (!open.length) return
    open[Math.floor(Math.random() * open.length)].sendCtl({ t: 'digest', d: this.digest(), a: this.auth.version })
  }

  private async acceptRecord(env: Envelope): Promise<void> {
    const opened = await open<MemberRecord>(env, 'rec')
    if (!opened || opened.body.id !== opened.author) return
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
      if (this.isBlocked(rec.id) && this.conns.has(rec.id)) {
        const c = this.conns.get(rec.id)!
        c.onStateChange = () => {}
        c.close()
        this.conns.delete(rec.id)
        this.markUnreachable(rec.id)
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

  private async sampleRtts(): Promise<void> {
    const rtt: Record<string, number> = {}
    await Promise.all(
      [...this.conns.values()]
        .filter((c) => c.isOpen)
        .map(async (c) => {
          const ms = (await c.statsRttMs()) ?? c.rttMs
          if (ms !== null) rtt[c.remoteId] = Math.round(ms)
        }),
    )
    this.updateRecord({ rtt })
  }

  // --- chat ----------------------------------------------------------------------------------------

  private async onChatEnv(env: Envelope, from: string): Promise<void> {
    const opened = await open<ChatBody>(env, 'chat')
    if (!opened) return
    const b = opened.body
    if (b.from !== opened.author || typeof b.text !== 'string' || b.text.length > CHAT_MAX_LEN) return
    if (this.chat.some((m) => m.id === b.id)) return
    // Senders are rate limited by everyone, so a flooding member can't drown the chat.
    const now = performance.now()
    const recent = (this.chatByAuthor.get(b.from) ?? []).filter((t) => now - t < CHAT_RATE.perMs)
    if (recent.length >= CHAT_RATE.count) return
    recent.push(now)
    this.chatByAuthor.set(b.from, recent)
    this.storeChat(b, env)
    // Forward to neighbours the sender can't reach directly.
    const unreachable = this.member(b.from)?.unreachable ?? []
    for (const id of unreachable) if (id !== from) this.conns.get(id)?.sendCtl({ t: 'chat', env })
  }

  private storeChat(b: ChatBody, env: Envelope): void {
    const m: ChatMessage = { id: b.id, from: b.from, name: b.name, text: b.text, at: b.at }
    this.chat = [...this.chat, m].sort((x, y) => x.at - y.at).slice(-CHAT_KEEP)
    this.chatEnvs = [...this.chatEnvs, env].slice(-CHAT_KEEP)
    this.onChat(m)
    this.onChange()
  }

  // --- dispatch ----------------------------------------------------------------------------------

  private handle(msg: MeshMsg, from: string, conn: MeshConn): void {
    if (this.conns.get(from) !== conn) return
    if (msg.t !== 'auth' && msg.t !== 'snapshot' && this.isBannedPeer(from)) {
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
      case 'snapshot':
        if (msg.auth) void this.acceptAuth(msg.auth)
        for (const env of msg.recs ?? []) void this.acceptRecord(env)
        for (const env of msg.chat ?? []) void this.onChatEnv(env, from)
        break
      case 'auth':
        void this.acceptAuth(msg.env)
        break
      case 'digest': {
        const { pull, push } = this.store.compare(msg.d ?? {})
        // Evidence that those peers are alive: someone heard a newer heartbeat.
        for (const id of pull) if (this.store.has(id)) this.detector.heard(id, performance.now())
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
    }
  }
}
