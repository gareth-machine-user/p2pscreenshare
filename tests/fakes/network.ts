// In-memory stand-ins for WebRTC and the tracker, so several Mesh instances can run in one test.
//
// FakeConn mimics MeshConn's ctl channel (JSON over a reliable, ordered link with a fixed delay),
// its ping/pong, and its offer/answer handshake: an "SDP" is a token naming the connection, and a
// pair opens once the offerer accepts the answer, unless the network blocks the pair (then the
// attempt fails at its deadline, as ICE would). FakeRendezvous stands in for the tracker: every
// door offers itself to every seeker and door in the lobby, with the mesh's own answer/admit rules.
//
// Everything is driven by timers, so tests run it under fake timers (see clock.ts).
import type { RendezvousOptions, RendezvousPort } from '../../src/net/bootstrap'
import type { LinkState } from '../../src/net/link'
import type { Ctl, PeerConn } from '../../src/mesh/meshConn'
import { every } from '../../src/net/ticker'

const CONNECT_TIMEOUT_MS = 15_000
const ANNOUNCE_MS = 1000

export interface FakeNetworkOptions {
  /** One-way delay of every message (ms). */
  delayMs?: number
  /** Chance that a message between two peers is dropped (0..1; the ctl channel is reliable, so keep 0 unless testing loss). */
  loss?: number
}

export class FakeNetwork {
  readonly delayMs: number
  loss: number
  /** Pairs that can't connect (as if ICE failed); key from pairKey. */
  private blockedPairs = new Set<string>()
  /** Pairs whose traffic is dropped (a partition: open links stay "open" but go silent). */
  private cutPairs = new Set<string>()
  /** Peers cut off from everyone. */
  private isolated = new Set<string>()
  private offers = new Map<string, FakeConn>()
  private answers = new Map<string, FakeConn>()
  private rendezvous: FakeRendezvous[] = []
  private seq = 0
  /** Every connection made, for assertions. */
  readonly conns: FakeConn[] = []

  constructor(opts: FakeNetworkOptions = {}) {
    this.delayMs = opts.delayMs ?? 5
    this.loss = opts.loss ?? 0
  }

  /** The connection factory for the peer `localId` (Mesh's `connect` option). */
  factory(localId: string): (iceServers: RTCIceServer[], remoteId: string) => FakeConn {
    return (_ice, remoteId) => this.makeConn(localId, remoteId)
  }

  /** The rendezvous factory for the peer `localId` (Mesh's `rendezvous` option). */
  rendezvousFor(localId: string): (opts: RendezvousOptions<FakeConn>) => RendezvousPort<FakeConn> {
    return () => {
      const r = new FakeRendezvous(this, localId)
      this.rendezvous.push(r)
      return r
    }
  }

  makeConn(localId: string, remoteId: string): FakeConn {
    const c = new FakeConn(this, localId, remoteId, `c${++this.seq}`)
    this.conns.push(c)
    return c
  }

  /** The pair can't connect (new attempts fail as if ICE did). */
  block(a: string, b: string): void {
    this.blockedPairs.add(pairKey(a, b))
  }

  /** Silently drops all traffic between the pair, open links included. */
  cut(a: string, b: string): void {
    this.cutPairs.add(pairKey(a, b))
  }

  /** Silently drops all traffic to and from `id` (it crashed, or its network went away). */
  isolate(id: string): void {
    this.isolated.add(id)
  }

  heal(): void {
    this.blockedPairs.clear()
    this.cutPairs.clear()
    this.isolated.clear()
  }

  canTalk(a: string, b: string): boolean {
    return !this.isolated.has(a) && !this.isolated.has(b) && !this.cutPairs.has(pairKey(a, b))
  }

  canConnect(a: string, b: string): boolean {
    return this.canTalk(a, b) && !this.blockedPairs.has(pairKey(a, b))
  }

  /** The live connection `to` holds towards `from`, if any. */
  connOf(to: string, from: string): FakeConn | undefined {
    return this.conns.find((c) => c.localId === to && c.remoteId === from && c.state === 'open')
  }

  /**
   * Delivers `msg` to `to` as if `from` sent it over their open link (bypassing `from`'s mesh, to
   * play a misbehaving peer). Returns false if there is no such link.
   */
  inject(from: string, to: string, msg: object): boolean {
    const c = this.connOf(to, from)
    if (!c) return false
    c.receive(JSON.stringify(msg))
    return true
  }

  /** Runs `fn` after the network delay (a timer, so fake timers drive it). */
  later(fn: () => void): void {
    setTimeout(fn, this.delayMs)
  }

  dropped(from: string, to: string): boolean {
    return !this.canTalk(from, to) || (this.loss > 0 && Math.random() < this.loss)
  }

  registerOffer(token: string, conn: FakeConn): void {
    this.offers.set(token, conn)
  }

  takeOffer(token: string): FakeConn | undefined {
    const c = this.offers.get(token)
    this.offers.delete(token)
    return c
  }

  registerAnswer(token: string, conn: FakeConn): void {
    this.answers.set(token, conn)
  }

  takeAnswer(token: string): FakeConn | undefined {
    const c = this.answers.get(token)
    this.answers.delete(token)
    return c
  }

  /** Rendezvous instances that are live in the swarm (seeking or door). */
  swarm(): FakeRendezvous[] {
    return this.rendezvous.filter((r) => r.inSwarm)
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export class FakeConn implements PeerConn {
  offerer = ''
  readonly createdAt = performance.now()
  state: LinkState = 'connecting'
  wasOpen = false
  haveRemote = false
  pingSentAt: number | null = null
  lastHeardAt = performance.now()
  rttMs: number | null = null

  onCtl: (msg: Ctl) => void = () => {}
  onMedia: (data: Uint8Array) => void = () => {}
  onBin: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  /** The other end, once the handshake paired them. */
  peer: FakeConn | null = null
  /** Ctl messages sent, for assertions. */
  readonly sent: Ctl[] = []
  private timeout: ReturnType<typeof setTimeout> | null = null
  private pingSeq = 0
  private pongWaiters = new Map<number, { sentAt: number; resolve: (remoteClock: number) => void }>()

  constructor(
    private net: FakeNetwork,
    readonly localId: string,
    public remoteId: string,
    readonly token: string,
  ) {}

  get isOpen(): boolean {
    return this.state === 'open'
  }

  armTimeout(ms = CONNECT_TIMEOUT_MS): void {
    if (this.timeout !== null || this.state !== 'connecting') return
    this.timeout = setTimeout(() => {
      if (this.state === 'connecting') this.setState('failed')
    }, ms)
  }

  async createOffer(): Promise<string> {
    this.net.registerOffer(this.token, this)
    return this.token
  }

  async acceptOffer(sdp: string): Promise<string> {
    const offerer = this.net.takeOffer(sdp)
    if (!offerer) throw new Error(`unknown offer ${sdp}`)
    this.peer = offerer
    this.haveRemote = true
    this.armTimeout()
    this.net.registerAnswer(this.token, this)
    return this.token
  }

  async acceptAnswer(sdp: string): Promise<void> {
    const answerer = this.net.takeAnswer(sdp)
    if (!answerer || answerer.peer !== this) throw new Error(`unknown answer ${sdp}`)
    this.peer = answerer
    this.haveRemote = true
    this.armTimeout()
    // "ICE": the pair opens after a round trip, unless the network keeps them apart (then both
    // sides fail at their deadlines).
    if (!this.net.canConnect(this.localId, answerer.localId)) return
    setTimeout(() => {
      if (!this.net.canConnect(this.localId, answerer.localId)) return
      if (this.state !== 'connecting' || answerer.state !== 'connecting') return
      this.setState('open')
      answerer.setState('open')
    }, this.net.delayMs * 2)
  }

  sendCtl(msg: object): boolean {
    if (this.state !== 'open') return false
    const json = JSON.stringify(msg)
    this.sent.push(JSON.parse(json) as Ctl)
    const peer = this.peer
    if (!peer || this.net.dropped(this.localId, peer.localId)) return true
    this.net.later(() => {
      if (this.state === 'open') peer.receive(json)
    })
    return true
  }

  /** A ctl message arriving from the remote. */
  receive(json: string): void {
    if (this.state !== 'open') return
    const msg = JSON.parse(json) as Ctl
    this.lastHeardAt = performance.now()
    if (msg.t === '__ping') this.sendCtl({ t: '__pong', id: msg.id, now: Date.now() })
    else if (msg.t === '__pong') this.onPong(msg.id as number, msg.now as number)
    else this.onCtl(msg)
  }

  ping(timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      const id = ++this.pingSeq
      const sentAt = performance.now()
      this.pingSentAt = sentAt
      const t = setTimeout(() => {
        this.pongWaiters.delete(id)
        reject(new Error('ping timeout'))
      }, timeoutMs)
      this.pongWaiters.set(id, {
        sentAt,
        resolve: (v) => {
          clearTimeout(t)
          resolve(v)
        },
      })
      if (!this.sendCtl({ t: '__ping', id })) {
        clearTimeout(t)
        this.pongWaiters.delete(id)
        reject(new Error('not connected'))
      }
    })
  }

  private onPong(id: number, remoteClock: number): void {
    const w = this.pongWaiters.get(id)
    if (!w) return
    this.pongWaiters.delete(id)
    const rtt = performance.now() - w.sentAt
    this.rttMs = this.rttMs === null ? rtt : this.rttMs * 0.8 + rtt * 0.2
    this.pingSentAt = null
    w.resolve(remoteClock)
  }

  async statsRttMs(): Promise<number | null> {
    return null
  }

  close(): void {
    const peer = this.peer
    const wasLive = this.state === 'open' || this.state === 'connecting'
    this.setState('closed')
    // The remote's channels close too, if the news can get there.
    if (wasLive && peer && !this.net.dropped(this.localId, peer.localId)) this.net.later(() => peer.setState('closed'))
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed' || this.state === 'failed') return
    this.state = state
    if (state === 'open') this.wasOpen = true
    if (state !== 'connecting' && this.timeout !== null) clearTimeout(this.timeout)
    this.onStateChange(state)
  }
}

/**
 * The tracker, in memory: each door periodically offers itself to everyone else in the swarm;
 * an offer goes through when the receiver would answer it (`shouldAnswer`) and the door admits the
 * answerer (`admit`), as in net/bootstrap.ts.
 */
export class FakeRendezvous implements RendezvousPort<FakeConn> {
  onConnection: (conn: FakeConn) => void = () => {}
  onTrackerStatus: (connected: number, total: number) => void = () => {}
  shouldAnswer: (peerId: string) => boolean = () => false
  admit: (peerId: string) => boolean = () => true

  private door = false
  private seeking = false
  private closed = false
  private stop: (() => void) | null = null

  constructor(
    private net: FakeNetwork,
    readonly id: string,
  ) {}

  async start(): Promise<void> {
    this.onTrackerStatus(1, 1)
    this.stop = every(ANNOUNCE_MS, () => this.announce())
  }

  get isDoor(): boolean {
    return this.door
  }

  get inSwarm(): boolean {
    return !this.closed && (this.door || this.seeking)
  }

  setDoor(on: boolean): void {
    if (!this.closed) this.door = on
  }

  setSeeking(on: boolean): void {
    if (!this.closed) this.seeking = on
  }

  close(): void {
    this.closed = true
    this.stop?.()
  }

  private announce(): void {
    if (this.closed || !this.door) return
    for (const other of this.net.swarm()) {
      if (other === this || !this.door) continue
      if (!other.shouldAnswer(this.id) || !this.admit(other.id)) continue
      void this.pair(other)
    }
  }

  private async pair(answerer: FakeRendezvous): Promise<void> {
    const mine = this.net.makeConn(this.id, '')
    mine.offerer = this.id
    const theirs = this.net.makeConn(answerer.id, this.id)
    theirs.offerer = this.id
    const offer = await mine.createOffer()
    const answer = await theirs.acceptOffer(offer)
    answerer.onConnection(theirs)
    mine.remoteId = answerer.id
    await mine.acceptAnswer(answer)
    this.onConnection(mine)
  }
}
