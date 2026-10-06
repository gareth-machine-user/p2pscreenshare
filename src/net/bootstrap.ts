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
import { MeshConn } from '../mesh/meshConn'
import { lobbyKeys, openJson, sealJson, type LobbyKeys } from './lobby'
import { DEFAULT_TRACKERS, randomPeerId, TrackerClient } from './tracker'

export { randomPeerId }

export const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

const OFFER_POOL = 4
const ANNOUNCE_MS = 3000
const SEEK_ANNOUNCE_MS = 15_000
const OFFER_MAX_AGE_MS = 50_000

interface DoorOffer {
  type: 'door-offer' | 'door-answer'
  peerId: string
  offerId: string
  sdp: string
}

export interface RendezvousOptions {
  joinCode: string
  identity: PeerIdentity
  trackers?: string[]
  iceServers: RTCIceServer[]
}

export class Rendezvous {
  /** A connection set up through the tracker; `conn.remoteId` is verified. */
  onConnection: (conn: MeshConn) => void = () => {}
  onTrackerStatus: (connected: number, total: number) => void = () => {}
  /** Whether to answer an offer from this (verified) peer. */
  shouldAnswer: (peerId: string) => boolean = () => false
  /** Whether to accept an answer from this (verified) peer. */
  admit: (peerId: string) => boolean = () => true

  private keys!: LobbyKeys
  private tracker!: TrackerClient
  private pool = new Map<string, { conn: MeshConn; sdp: string; at: number }>()
  private filling = false
  private door = false
  private seeking = false
  private answering = new Set<string>()
  private timers: ReturnType<typeof setInterval>[] = []
  private closed = false

  constructor(private opts: RendezvousOptions) {}

  async start(): Promise<void> {
    this.keys = await lobbyKeys(this.opts.joinCode)
    const urls = this.opts.trackers?.length ? this.opts.trackers : DEFAULT_TRACKERS
    this.tracker = new TrackerClient(urls, this.keys.infoHash, this.opts.identity.id)
    this.tracker.onStatus = (c, t) => this.onTrackerStatus(c, t)
    this.tracker.onOffer = (o) => void this.onOffer(o.offerId, o.sdp, o.reply)
    this.tracker.onAnswer = (a) => void this.onAnswer(a.offerId, a.sdp)
    this.timers.push(setInterval(() => this.announce(), ANNOUNCE_MS))
    this.timers.push(setInterval(() => this.seeking && !this.door && this.tracker.announce({ numwant: 10 }), SEEK_ANNOUNCE_MS))
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
          const conn = new MeshConn(this.opts.iceServers, '')
          const offerId = randomPeerId()
          const sdp = await conn.createOffer()
          const env = await seal<DoorOffer>(this.opts.identity, { type: 'door-offer', peerId: this.opts.identity.id, offerId, sdp }, Infinity)
          return { offerId, conn, sdp: await sealJson(this.keys, 'offer', offerId, env) }
        }),
      )
      for (const { offerId, ...f } of fresh) {
        if (this.door) this.pool.set(offerId, { ...f, at: performance.now() })
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
    this.answering.add(offer.peerId)
    const conn = new MeshConn(this.opts.iceServers, offer.peerId)
    const release = () => this.answering.delete(offer.peerId)
    conn.onStateChange = (s) => {
      if (s !== 'connecting') release()
    }
    try {
      const sdp = await conn.acceptOffer(offer.sdp)
      const env = await seal<DoorOffer>(this.opts.identity, { type: 'door-answer', peerId: this.opts.identity.id, offerId, sdp }, Infinity)
      reply(await sealJson(this.keys, 'answer', offerId, env))
      this.onConnection(conn)
    } catch (err) {
      console.warn('answering offer failed', err)
      conn.close()
      release()
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
      o.conn.close()
    }
    void this.fill()
  }

  close(): void {
    this.closed = true
    this.timers.forEach(clearInterval)
    for (const o of this.pool.values()) o.conn.close()
    this.pool.clear()
    this.tracker?.announce({ event: 'stopped' })
    setTimeout(() => this.tracker?.close(), 200)
  }
}
