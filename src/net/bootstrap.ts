// Bootstrap through WebTorrent trackers: door peers keep offer pools; joiners answer one.
//
// Door duty belongs to the owner plus the two oldest present members (see mesh/records.ts), and
// moves automatically as members leave. Each door keeps a small pool of pre-gathered WebRTC offers
// announced to the lobby's info-hash; the tracker hands each offer to a distinct peer in the swarm.
// A joiner answers the first offer it can open and verify, and once its door link is up it leaves
// the swarm and meshes with everyone else over that link (mesh/mesh.ts).
//
// Offers and answers are sealed with a key derived from the join code (see lobby.ts), so only
// peers holding the code can read or answer them. Inside the seal, each side signs its SDP with its
// peer key, binding the connection (via the DTLS fingerprints in the SDP) to that peer id.
//
// Doors also receive each other's offers. A door answers one from a door it doesn't know whose id
// is lower than its own, so two groups that formed apart (say, while the owner was away and the
// tracker was flaky) merge, and each pair connects only once.
import { open, seal, type Envelope } from '../mesh/envelope'
import type { PeerIdentity } from '../mesh/identity'
import { MeshConn, type ConnFactory, type PeerConn } from '../mesh/meshConn'
import { lobbyKeys, openJson, sealJson, type LobbyKeys } from './lobby'
import { DEFAULT_TRACKERS, randomPeerId, TrackerClient } from './tracker'
import { every } from './ticker'

export { randomPeerId }

export const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

const OFFER_POOL = 4
const ANNOUNCE_MS = 3000
const SEEK_ANNOUNCE_MS = 15_000
const OFFER_MAX_AGE_MS = 50_000
const TRACKER_CLOSE_DELAY_MS = 200

interface DoorOffer {
  type: 'door-offer' | 'door-answer'
  peerId: string
  offerId: string
  sdp: string
}

export interface RendezvousOptions<C extends PeerConn = MeshConn> {
  joinCode: string
  identity: PeerIdentity
  trackers?: string[]
  iceServers: RTCIceServer[]
  /** Makes connections (default: a real MeshConn). */
  connect?: ConnFactory<C>
}

/** What the mesh uses of a rendezvous, so tests can bootstrap without a tracker (tests/fakes/). */
export interface RendezvousPort<C extends PeerConn = MeshConn> {
  onConnection: (conn: C) => void
  onTrackerStatus: (connected: number, total: number) => void
  shouldAnswer: (peerId: string) => boolean
  admit: (peerId: string) => boolean
  readonly isDoor: boolean
  start(): Promise<void>
  setDoor(on: boolean): void
  setSeeking(on: boolean): void
  close(): void
}

export class Rendezvous<C extends PeerConn = MeshConn> implements RendezvousPort<C> {
  /** A connection set up through the tracker; `conn.remoteId` is verified. */
  onConnection: (conn: C) => void = () => {}
  onTrackerStatus: (connected: number, total: number) => void = () => {}
  /** Whether to answer an offer from this (verified) peer. */
  shouldAnswer: (peerId: string) => boolean = () => false
  /** Whether to accept an answer from this (verified) peer. */
  admit: (peerId: string) => boolean = () => true

  private keys!: LobbyKeys
  private tracker!: TrackerClient
  private pool = new Map<string, { conn: C; sdp: string; at: number }>()
  private filling = false
  private door = false
  private seeking = false
  private answering = new Set<string>()
  private timers: (() => void)[] = []
  private closed = false

  private connect: ConnFactory<C>

  constructor(private opts: RendezvousOptions<C>) {
    // Without a factory, C is MeshConn (the type parameter's default).
    this.connect = opts.connect ?? (((ice, id) => new MeshConn(ice, id)) as ConnFactory as ConnFactory<C>)
  }

  async start(): Promise<void> {
    this.keys = await lobbyKeys(this.opts.joinCode)
    const urls = this.opts.trackers?.length ? this.opts.trackers : DEFAULT_TRACKERS
    this.tracker = new TrackerClient(urls, this.keys.infoHash, this.opts.identity.id)
    this.tracker.onStatus = (c, t) => this.onTrackerStatus(c, t)
    this.tracker.onOffer = (o) => void this.onOffer(o.offerId, o.sdp, o.reply)
    this.tracker.onAnswer = (a) => void this.onAnswer(a.offerId, a.sdp)
    this.timers.push(every(ANNOUNCE_MS, () => this.announce()))
    this.timers.push(every(SEEK_ANNOUNCE_MS, () => this.seeking && !this.door && this.tracker.announce({ numwant: 10 })))
  }

  get isDoor(): boolean {
    return this.door
  }

  /** Door duty: keep an offer pool announced on the tracker. */
  setDoor(on: boolean): void {
    if (on === this.door || this.closed) return
    this.door = on
    if (on) {
      void this.fill()
    } else {
      for (const o of this.pool.values()) o.conn.close()
      this.pool.clear()
      if (!this.seeking) this.tracker.announce({ event: 'stopped' })
      else this.tracker.announce({ numwant: 10 })
    }
  }

  /** Joining: stay in the swarm to receive offers. */
  setSeeking(on: boolean): void {
    if (on === this.seeking || this.closed) return
    this.seeking = on
    if (on) this.tracker.announce({ event: 'started', numwant: 10 })
    else if (!this.door) this.tracker.announce({ event: 'stopped' })
  }

  private announce(): void {
    if (this.closed || !this.door) return
    void this.fill()
  }

  private async fill(): Promise<void> {
    if (this.filling || this.closed || !this.door) return
    this.filling = true
    try {
      const now = performance.now()
      for (const [id, o] of this.pool) {
        if (now - o.at > OFFER_MAX_AGE_MS) {
          o.conn.close()
          this.pool.delete(id)
        }
      }
      const fresh = await Promise.all(
        Array.from({ length: Math.max(0, OFFER_POOL - this.pool.size) }, async () => {
          // The remote id is filled in once an answer arrives.
          const conn = this.connect(this.opts.iceServers, '')
          conn.offerer = this.opts.identity.id
          const offerId = randomPeerId()
          try {
            const sdp = await conn.createOffer()
            const env = await seal<DoorOffer>(this.opts.identity, { type: 'door-offer', peerId: this.opts.identity.id, offerId, sdp }, Infinity)
            return { offerId, conn, sdp: await sealJson(this.keys, 'offer', offerId, env) }
          } catch (err) {
            // One failed offer doesn't spoil the others.
            console.warn('door offer failed', err)
            conn.close()
            return null
          }
        }),
      )
      for (const f of fresh) {
        if (!f) continue
        // Door duty may have ended (or the rendezvous closed) while the offers were gathering.
        if (this.door && !this.closed) this.pool.set(f.offerId, { conn: f.conn, sdp: f.sdp, at: performance.now() })
        else f.conn.close()
      }
    } finally {
      this.filling = false
    }
    if (this.door && !this.closed) {
      this.tracker.announce({
        offers: [...this.pool].map(([offerId, o]) => ({ offerId, sdp: o.sdp })),
        numwant: this.pool.size,
      })
    }
  }

  private async openSealed(kind: 'offer' | 'answer', offerId: string, sealed: string): Promise<DoorOffer | null> {
    const env = (await openJson(this.keys, kind, offerId, sealed)) as Envelope | null
    if (!env) return null // not from a peer holding the join code
    const opened = await open<DoorOffer>(env, kind === 'offer' ? 'door-offer' : 'door-answer')
    if (!opened || opened.body.peerId !== opened.author || opened.body.offerId !== offerId) return null
    return opened.body
  }

  private async onOffer(offerId: string, sealed: string, reply: (sdp: string) => void): Promise<void> {
    if (this.closed) return
    const offer = await this.openSealed('offer', offerId, sealed)
    if (!offer || offer.peerId === this.opts.identity.id) return
    if (this.answering.has(offer.peerId) || !this.shouldAnswer(offer.peerId)) return
    // Guards against answering two offers from one peer at once; the mesh takes the connection
    // (and dedupes links) as soon as the answer is out, so the guard ends there.
    this.answering.add(offer.peerId)
    const conn = this.connect(this.opts.iceServers, offer.peerId)
    conn.offerer = offer.peerId
    try {
      const sdp = await conn.acceptOffer(offer.sdp)
      const env = await seal<DoorOffer>(this.opts.identity, { type: 'door-answer', peerId: this.opts.identity.id, offerId, sdp }, Infinity)
      reply(await sealJson(this.keys, 'answer', offerId, env))
      this.onConnection(conn)
    } catch (err) {
      console.warn('answering offer failed', err)
      conn.close()
    } finally {
      this.answering.delete(offer.peerId)
    }
  }

  private async onAnswer(offerId: string, sealed: string): Promise<void> {
    if (!this.pool.has(offerId)) return
    const answer = await this.openSealed('answer', offerId, sealed)
    if (!answer || !this.admit(answer.peerId)) return
    const o = this.pool.get(offerId)
    if (!o) return
    this.pool.delete(offerId)
    o.conn.remoteId = answer.peerId
    try {
      await o.conn.acceptAnswer(answer.sdp)
      this.onConnection(o.conn)
    } catch {
      // a bad answer SDP: this offer is spent either way
      o.conn.close()
    }
    void this.fill()
  }

  close(): void {
    this.closed = true
    this.timers.forEach((cancel) => cancel())
    for (const o of this.pool.values()) o.conn.close()
    this.pool.clear()
    this.tracker?.announce({ event: 'stopped' })
    // Give the 'stopped' announce a moment to go out.
    setTimeout(() => this.tracker?.close(), TRACKER_CLOSE_DELAY_MS)
  }
}
