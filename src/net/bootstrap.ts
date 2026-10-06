// Bootstrap: host <-> viewer control connections, brokered by WebTorrent trackers.
//
// The host keeps a pool of pre-gathered WebRTC offers and announces them; trackers hand each offer
// to a distinct joining viewer, which answers through the tracker. Once connected, a viewer leaves
// the tracker swarm, so the swarm only ever holds the host plus viewers that are still joining.
// Everything after that (tree links, stats, topology) flows over these control connections.
//
// Offers and answers are sealed with a key derived from the join code (see lobby.ts), so only
// peers holding the code can connect: anyone else on the swarm gets offers it can't open, and
// answers that don't open are dropped before the host touches them. Offers are also signed by
// the host, so a viewer (who holds the code too) can't pose as the host to others.
import { lobbyKeys, openSignal, sealSignal, signOffer, verifyOffer } from './lobby'
import { DEFAULT_TRACKERS, randomPeerId, TrackerClient } from './tracker'

export { randomPeerId }

export const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

const OFFER_POOL = 8
const HOST_ANNOUNCE_MS = 3000
const VIEWER_ANNOUNCE_MS = 15_000
const OFFER_MAX_AGE_MS = 50_000
const ICE_GATHER_TIMEOUT_MS = 2500
const CONNECT_TIMEOUT_MS = 15_000
const BIN_BUFFER_HIGH = 1024 * 1024

export interface ControlChannel<In, Out> {
  selfId: string
  send(msg: Out, to: string): void
  onMessage: (msg: In, from: string) => void
  onPeerJoin: (peerId: string) => void
  onPeerLeave: (peerId: string) => void
  /** Binary side channel (upload probe). Resolves once buffered for sending. */
  sendBinary(data: Uint8Array, to: string): Promise<void>
  onBinary: (data: Uint8Array, from: string) => void
  /** Clock sync (also a liveness check): resolves with the remote's wall clock. */
  requestClock(to: string, timeoutMs?: number): Promise<number>
  /** Tracker connectivity (connected sockets / configured). */
  onTrackerStatus: (connected: number, total: number) => void
  /** Closes the control connection to a peer. */
  disconnect(peerId: string): void
  leave(): Promise<void>
}

export interface BootstrapOptions {
  /** The lobby's join code. */
  streamId: string
  role: 'host' | 'viewer'
  /** Host: key to sign offers with. */
  signingKey?: CryptoKey
  /** Viewer: the host key pinned by the join code; offers not signed by it are ignored. */
  hostKey?: CryptoKey
  trackers?: string[]
  iceServers?: RTCIceServer[]
  /** 20-character peer id (see randomPeerId). */
  peerId: string
}

export function wallClock(): number {
  return performance.timeOrigin + performance.now()
}

/** A WebRTC connection carrying the reliable control channel and the binary side channel. */
class ControlConn {
  readonly pc: RTCPeerConnection
  readonly ctl: RTCDataChannel
  readonly bin: RTCDataChannel
  peerId: string | null = null
  readonly createdAt = performance.now()

  constructor(iceServers: RTCIceServer[]) {
    this.pc = new RTCPeerConnection({ iceServers })
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true })
    this.bin = this.pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
    this.bin.binaryType = 'arraybuffer'
    this.bin.bufferedAmountLowThreshold = BIN_BUFFER_HIGH / 4
  }

  /** Waits for ICE gathering (trackers can't trickle), bounded by a timeout. */
  async gathered(): Promise<string> {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS)
        this.pc.addEventListener('icegatheringstatechange', () => {
          if (this.pc.iceGatheringState === 'complete') {
            clearTimeout(t)
            resolve()
          }
        })
      })
    }
    return this.pc.localDescription!.sdp
  }

  close(): void {
    try {
      this.pc.close()
    } catch {
      // ignore
    }
  }
}

export async function joinStream<In, Out>(opts: BootstrapOptions): Promise<ControlChannel<In, Out>> {
  const selfId = opts.peerId
  const iceServers = opts.iceServers ?? DEFAULT_ICE
  const keys = await lobbyKeys(opts.streamId)
  const tracker = new TrackerClient(opts.trackers?.length ? opts.trackers : DEFAULT_TRACKERS, keys.infoHash, selfId)
  const conns = new Map<string, ControlConn>()
  const clockWaiters = new Map<number, (t: number) => void>()
  let clockSeq = 0
  let left = false
  const timers: ReturnType<typeof setInterval>[] = []

  const channel: ControlChannel<In, Out> = {
    selfId,
    send(msg, to) {
      const c = conns.get(to)
      if (c?.ctl.readyState === 'open') c.ctl.send(JSON.stringify(msg))
    },
    onMessage: () => {},
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    async sendBinary(data, to) {
      const c = conns.get(to)
      if (!c || c.bin.readyState !== 'open') throw new Error('not connected')
      if (c.bin.bufferedAmount > BIN_BUFFER_HIGH) {
        await new Promise<void>((r) => c.bin.addEventListener('bufferedamountlow', () => r(), { once: true }))
      }
      c.bin.send(data as Uint8Array<ArrayBuffer>)
    },
    onBinary: () => {},
    requestClock(to, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const id = ++clockSeq
        const t = setTimeout(() => {
          clockWaiters.delete(id)
          reject(new Error('clock timeout'))
        }, timeoutMs)
        clockWaiters.set(id, (v) => {
          clearTimeout(t)
          resolve(v)
        })
        const c = conns.get(to)
        if (c?.ctl.readyState === 'open') c.ctl.send(JSON.stringify({ t: '__ping', id }))
      })
    },
    onTrackerStatus: () => {},
    disconnect(peerId) {
      const c = conns.get(peerId)
      conns.delete(peerId)
      c?.close()
    },
    async leave() {
      left = true
      timers.forEach(clearInterval)
      tracker.announce({ event: 'stopped' })
      setTimeout(() => tracker.close(), 200)
      for (const c of conns.values()) c.close()
      conns.clear()
    },
  }
  tracker.onStatus = (c, t) => channel.onTrackerStatus(c, t)

  /** Wires a connection whose remote peer id is known. */
  const attach = (c: ControlConn, peerId: string, onOpen: () => void, onDrop: () => void = () => {}) => {
    c.peerId = peerId
    let joined = false
    let gone = false
    const drop = () => {
      if (gone) return
      gone = true
      if (conns.get(peerId) === c) conns.delete(peerId)
      c.close()
      onDrop()
      if (joined) channel.onPeerLeave(peerId)
    }
    const timeout = setTimeout(() => {
      if (!joined) drop()
    }, CONNECT_TIMEOUT_MS)
    c.ctl.onopen = () => {
      clearTimeout(timeout)
      joined = true
      conns.set(peerId, c)
      onOpen()
      channel.onPeerJoin(peerId)
    }
    c.ctl.onclose = drop
    c.pc.onconnectionstatechange = () => {
      if (c.pc.connectionState === 'failed' || c.pc.connectionState === 'closed') drop()
    }
    c.ctl.onmessage = (ev) => {
      let msg: { t?: string; id?: number; now?: number }
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (msg.t === '__ping') {
        c.ctl.send(JSON.stringify({ t: '__pong', id: msg.id, now: wallClock() }))
      } else if (msg.t === '__pong') {
        clockWaiters.get(msg.id!)?.(msg.now!)
        clockWaiters.delete(msg.id!)
      } else {
        channel.onMessage(msg as In, peerId)
      }
    }
    c.bin.onmessage = (ev) => channel.onBinary(new Uint8Array(ev.data as ArrayBuffer), peerId)
  }

  if (opts.role === 'host') {
    // Pool of outstanding offers, keyed by offer id. `sdp` is sealed.
    const pool = new Map<string, { conn: ControlConn; sdp: string; at: number }>()
    let filling = false
    let announceTimer: ReturnType<typeof setTimeout> | null = null

    const announceSoon = (delay = 150) => {
      if (announceTimer) return
      announceTimer = setTimeout(() => {
        announceTimer = null
        if (left) return
        tracker.announce({ offers: [...pool].map(([offerId, o]) => ({ offerId, sdp: o.sdp })), numwant: pool.size })
      }, delay)
    }

    const fill = async () => {
      if (filling || left) return
      filling = true
      try {
        const now = performance.now()
        for (const [id, o] of pool) {
          if (now - o.at > OFFER_MAX_AGE_MS) {
            o.conn.close()
            pool.delete(id)
          }
        }
        const fresh = await Promise.all(
          Array.from({ length: Math.max(0, OFFER_POOL - pool.size) }, async () => {
            const conn = new ControlConn(iceServers)
            await conn.pc.setLocalDescription(await conn.pc.createOffer())
            const offerId = randomPeerId()
            const body = await signOffer(opts.signingKey!, offerId, { peerId: selfId, sdp: await conn.gathered() })
            const sdp = await sealSignal(keys, 'offer', offerId, body)
            return { offerId, conn, sdp }
          }),
        )
        for (const { offerId, ...f } of fresh) pool.set(offerId, { ...f, at: performance.now() })
      } finally {
        filling = false
      }
      announceSoon(0)
    }

    tracker.onAnswer = async (a) => {
      if (!pool.has(a.offerId)) return
      const body = await openSignal(keys, 'answer', a.offerId, a.sdp)
      if (!body) return // not from a peer holding the join code
      const o = pool.get(a.offerId)
      if (!o || conns.has(body.peerId)) return
      pool.delete(a.offerId)
      attach(o.conn, body.peerId, () => {})
      o.conn.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp }).catch(() => o.conn.close())
      void fill()
    }
    void fill()
    timers.push(setInterval(() => {
      void fill()
      announceSoon(0)
    }, HOST_ANNOUNCE_MS))
  } else {
    let pending: ControlConn | null = null
    let connected = false

    tracker.onOffer = async (o) => {
      if (connected || pending) return
      const offer = await openSignal(keys, 'offer', o.offerId, o.sdp)
      if (!offer || !opts.hostKey || !(await verifyOffer(opts.hostKey, o.offerId, offer))) return // not this lobby's host
      if (connected || pending) return // raced with another offer
      const conn = new ControlConn(iceServers)
      pending = conn
      attach(
        conn,
        offer.peerId,
        () => {
          connected = true
          pending = null
          // Leave the swarm so the host's offers only go to viewers that still need one.
          tracker.announce({ event: 'stopped' })
        },
        () => {
          if (pending === conn) pending = null
          if (connected && !left) {
            // Lost the host: rejoin the swarm and wait for a fresh offer.
            connected = false
            tracker.announce({ event: 'started', numwant: 10 })
          }
        },
      )
      // If this attempt dies before connecting, accept the next offer.
      const release = setTimeout(() => {
        if (pending === conn) pending = null
      }, CONNECT_TIMEOUT_MS + 500)
      try {
        await conn.pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
        await conn.pc.setLocalDescription(await conn.pc.createAnswer())
        o.reply(await sealSignal(keys, 'answer', o.offerId, { peerId: selfId, sdp: await conn.gathered() }))
      } catch (err) {
        console.warn('answering offer failed', err)
        clearTimeout(release)
        conn.close()
        if (pending === conn) pending = null
      }
    }
    tracker.announce({ event: 'started', numwant: 10 })
    timers.push(setInterval(() => {
      if (!connected) tracker.announce({ numwant: 10 })
    }, VIEWER_ANNOUNCE_MS))
  }

  return channel
}
