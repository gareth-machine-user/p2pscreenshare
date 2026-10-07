// One mesh connection per pair of peers: a reliable, ordered `ctl` channel (gossip, chat, tree
// commands, stats), an unreliable `media` channel (fragments), and a reliable `bin` channel for
// upload probes. A tree edge is just "forward channel X stripe s over this pair's media channel",
// so joining or switching parents never needs new ICE or DTLS setup.
import { wallClock } from '../net/clock'
import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_LOW, type LinkState, type MediaLink, type ProbeLink } from '../net/link'
import { parseLinkStats, type StatsLike } from '../net/linkStats'
import { after } from '../net/ticker'
import { tuning } from '../tuning'

const ICE_GATHER_TIMEOUT_MS = 2500
export const CONNECT_TIMEOUT_MS = 15_000

export type Ctl = { t: string; [k: string]: unknown }

/**
 * What the mesh and the rendezvous use of a connection, so tests can substitute an in-memory one
 * (tests/fakes/). MeshConn is the real thing.
 */
export interface PeerConn extends MediaLink {
  remoteId: string
  offerer: string
  readonly createdAt: number
  readonly state: LinkState
  readonly wasOpen: boolean
  readonly haveRemote: boolean
  readonly isOpen: boolean
  readonly pingSentAt: number | null
  readonly lastHeardAt: number
  readonly rttMs: number | null
  onCtl: (msg: Ctl) => void
  onMedia: (data: Uint8Array) => void
  onStateChange: (state: LinkState) => void
  onBufferLow: () => void
  armTimeout(ms?: number): void
  createOffer(): Promise<string>
  acceptOffer(sdp: string): Promise<string>
  acceptAnswer(sdp: string): Promise<void>
  sendCtl(msg: object): boolean
  ping(timeoutMs?: number): Promise<number>
  statsRttMs(): Promise<number | null>
  /** Whether the selected candidate pair goes through a TURN relay (null: unknown). */
  usesRelay(): Promise<boolean | null>
  /** The connection's getStats() report (absent in tests' fakes; null when closed). */
  stats?(): Promise<StatsLike | null>
  /** The `bin` channel as a probe link (see session/headroom.ts). */
  readonly probeLink: ProbeLink
  close(): void
}

/** Waits for ICE gathering (signaling is not trickled), bounded by a timeout; returns the local SDP. */
export async function gatherComplete(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ICE_GATHER_TIMEOUT_MS)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t)
          resolve()
        }
      })
    })
  }
  return pc.localDescription!.sdp
}

/** A connection's getStats() report, or null when stats are unavailable (closed). */
export async function connStats(pc: RTCPeerConnection): Promise<StatsLike | null> {
  try {
    return (await pc.getStats()) as unknown as StatsLike
  } catch {
    return null
  }
}

/**
 * Whether a connection's selected candidate pair is relayed through TURN (either end a `relay`
 * candidate). Null when stats don't say (closed, not yet selected).
 */
export async function selectedPairRelayed(pc: RTCPeerConnection): Promise<boolean | null> {
  const report = await connStats(pc)
  return (report && parseLinkStats(report)?.relayed) ?? null
}

/** Sets up a connection's reliable `bin` channel: buffer-low events drive the probe's refills. */
export function setUpBin(bin: RTCDataChannel): void {
  bin.binaryType = 'arraybuffer'
  bin.bufferedAmountLowThreshold = BACKGROUND_BUFFER_MAX / 2
}

/** A reliable `bin` channel as a ProbeLink (received bytes are dropped: nothing reads them). */
export function binProbeLink(bin: RTCDataChannel, state: () => LinkState): ProbeLink {
  const link: ProbeLink = {
    get isOpen() {
      return bin.readyState === 'open'
    },
    get state() {
      return state()
    },
    get bufferedAmount() {
      return bin.bufferedAmount
    },
    onBufferLow: null,
    send(data: Uint8Array) {
      if (bin.readyState !== 'open') return false
      try {
        bin.send(data as Uint8Array<ArrayBuffer>)
        return true
      } catch {
        // closed between the check and the send
        return false
      }
    },
  }
  bin.addEventListener('bufferedamountlow', () => link.onBufferLow?.())
  return link
}

/** Makes a connection to `remoteId` ('' when not yet known, e.g. a door's pooled offer). */
export type ConnFactory<C extends PeerConn = PeerConn> = (iceServers: RTCIceServer[], remoteId: string) => C

export class MeshConn implements MediaLink, PeerConn {
  readonly pc: RTCPeerConnection
  readonly ctl: RTCDataChannel
  readonly media: RTCDataChannel
  readonly bin: RTCDataChannel
  readonly createdAt = performance.now()
  state: LinkState = 'connecting'
  /** Whether this link was ever open (a failure before that means the pair can't connect). */
  wasOpen = false
  /** Whether the remote SDP arrived, so ICE was actually attempted. */
  haveRemote = false
  /** Peer id of the side that made the offer (breaks ties between duplicate connections). */
  offerer = ''
  /** Liveness: last ping sent, last pong (or any message) received. */
  pingSentAt: number | null = null
  lastHeardAt = performance.now()
  /** Smoothed ping round-trip time. */
  rttMs: number | null = null

  onCtl: (msg: Ctl) => void = () => {}
  onMedia: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  private pingSeq = 0
  private pongWaiters = new Map<number, { sentAt: number; resolve: (remoteClock: number) => void }>()
  private timeout: (() => void) | null = null

  constructor(
    iceServers: RTCIceServer[],
    /** Remote peer id (verified by whoever set up the connection). */
    public remoteId: string,
  ) {
    this.pc = new RTCPeerConnection({ iceServers })
    this.media = this.pc.createDataChannel('media', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: tuning.mediaMaxPacketLifeTimeMs })
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true })
    this.bin = this.pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
    this.media.binaryType = 'arraybuffer'
    this.media.bufferedAmountLowThreshold = LINK_BUFFER_LOW
    setUpBin(this.bin)

    this.ctl.onopen = () => this.setState('open')
    this.ctl.onclose = () => this.setState('closed')
    this.media.onbufferedamountlow = () => this.onBufferLow()
    this.media.onmessage = (ev) => this.onMedia(new Uint8Array(ev.data as ArrayBuffer))
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
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.setState('failed')
      if (this.pc.connectionState === 'closed') this.setState('closed')
    }
  }

  /**
   * Starts the connect deadline. Called once an attempt is really under way (an answer is out, or
   * the remote SDP arrived): a door's pooled offer may wait on the tracker for much longer.
   */
  armTimeout(ms = CONNECT_TIMEOUT_MS): void {
    if (this.timeout !== null || this.state !== 'connecting') return
    this.timeout = after(ms, () => {
      if (this.state === 'connecting') this.setState('failed')
    })
  }

  /** Waits for ICE gathering (signaling is not trickled), bounded by a timeout. */
  gathered(): Promise<string> {
    return gatherComplete(this.pc)
  }

  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    return this.gathered()
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    this.haveRemote = true
    this.armTimeout()
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    return this.gathered()
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
    this.haveRemote = true
    this.armTimeout()
  }

  get isOpen(): boolean {
    return this.state === 'open' && this.media.readyState === 'open'
  }

  get bufferedAmount(): number {
    return this.media.bufferedAmount
  }

  /** Sends a media fragment (unreliable channel). */
  send(data: Uint8Array): boolean {
    if (!this.isOpen) return false
    try {
      this.media.send(data as Uint8Array<ArrayBuffer>)
      return true
    } catch {
      // closed between the check and the send
      return false
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

  /** The probe channel as a MediaLink, so probe traffic can share the uplink queue fairly. */
  get probeLink(): ProbeLink {
    this._probeLink ??= binProbeLink(this.bin, () => this.state)
    return this._probeLink
  }
  private _probeLink: ProbeLink | null = null

  usesRelay(): Promise<boolean | null> {
    return selectedPairRelayed(this.pc)
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

  /** Round-trip time of the selected candidate pair, if known. */
  async statsRttMs(): Promise<number | null> {
    const report = await connStats(this.pc)
    return (report && parseLinkStats(report)?.currentRttMs) ?? null
  }

  stats(): Promise<StatsLike | null> {
    return connStats(this.pc)
  }

  close(): void {
    this.setState('closed')
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed' || this.state === 'failed') return
    this.state = state
    if (state === 'open') this.wasOpen = true
    if (state !== 'connecting') this.timeout?.()
    if (state === 'closed' || state === 'failed') {
      try {
        this.pc.close()
      } catch {
        // already closed
      }
    }
    this.onStateChange(state)
  }
}
