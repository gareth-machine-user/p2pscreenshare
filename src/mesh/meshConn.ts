// One mesh connection per pair of peers: a reliable, ordered `ctl` channel (gossip, chat, tree
// commands, stats) on top of what every connection has (dataConn.ts): an unreliable `media`
// channel (fragments) and a reliable `bin` channel for headroom probes. A tree edge is just
// "forward channel X stripe s over this pair's media channel", so joining or switching parents
// never needs new ICE or DTLS setup.
import { wallClock } from '../net/clock'
import { after } from '../net/ticker'
import { DataConn, type PairConn } from './dataConn'

export type Ctl = { t: string; [k: string]: unknown }

/**
 * What the mesh and the rendezvous use of a mesh connection, so tests can substitute an in-memory
 * one (tests/fakes/). MeshConn is the real thing.
 */
export interface PeerConn extends PairConn {
  remoteId: string
  offerer: string
  readonly createdAt: number
  readonly haveRemote: boolean
  readonly pingSentAt: number | null
  readonly lastHeardAt: number
  readonly rttMs: number | null
  onCtl: (msg: Ctl) => void
  sendCtl(msg: object): boolean
  ping(timeoutMs?: number): Promise<number>
  /** Whether the selected candidate pair goes through a TURN relay (null: unknown). */
  usesRelay(): Promise<boolean | null>
}

/** Makes a connection to `remoteId` ('' when not yet known, e.g. a door's pooled offer). */
export type ConnFactory<C extends PeerConn = PeerConn> = (iceServers: RTCIceServer[], remoteId: string) => C

export class MeshConn extends DataConn implements PeerConn {
  readonly ctl: RTCDataChannel
  readonly createdAt = performance.now()
  /** Peer id of the side that made the offer (breaks ties between duplicate connections). */
  offerer = ''
  /** Liveness: last ping sent, last pong (or any message) received. */
  pingSentAt: number | null = null
  lastHeardAt = performance.now()
  /** Smoothed ping round-trip time (rides inside SCTP, so it queues behind the connection's backlog). */
  rttMs: number | null = null

  onCtl: (msg: Ctl) => void = () => {}

  private pingSeq = 0
  private pongWaiters = new Map<number, { sentAt: number; resolve: (remoteClock: number) => void }>()

  constructor(iceServers: RTCIceServer[], remoteId: string) {
    super(iceServers, remoteId)
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true })
    this.ctl.onopen = () => this.setState('open')
    this.ctl.onclose = () => this.setState('closed')
    this.ctl.onmessage = (ev) => {
      let msg: Ctl
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return // not JSON, so not from a peer running this code
      }
      this.lastHeardAt = performance.now()
      // Answered here, from the message handler: background-tab timer throttling can't delay it.
      if (msg.t === '__ping') this.sendCtl({ t: '__pong', id: msg.id, now: wallClock() })
      else if (msg.t === '__pong') this.onPong(msg.id as number, msg.now as number)
      else this.onCtl(msg)
    }
  }

  sendCtl(msg: object): boolean {
    if (this.ctl.readyState !== 'open') return false
    try {
      this.ctl.send(JSON.stringify(msg))
      return true
    } catch {
      // closed between the check and the send
      return false
    }
  }

  /** Pings the remote; resolves with its wall clock (for clock sync), rejects on timeout. */
  ping(timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      const id = ++this.pingSeq
      const sentAt = performance.now()
      this.pingSentAt = sentAt
      const cancel = after(timeoutMs, () => {
        this.pongWaiters.delete(id)
        reject(new Error('ping timeout'))
      })
      this.pongWaiters.set(id, {
        sentAt,
        resolve: (v) => {
          cancel()
          resolve(v)
        },
      })
      if (!this.sendCtl({ t: '__ping', id })) {
        cancel()
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
}
