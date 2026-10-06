// One mesh connection per pair of peers: a reliable, ordered `ctl` channel (gossip, chat, tree
// commands, stats), an unreliable `media` channel (fragments), and a reliable `bin` channel for
// upload probes. A tree edge is just "forward channel X stripe s over this pair's media channel",
// so joining or switching parents never needs new ICE or DTLS setup.
import { wallClock } from '../net/clock'
import { LINK_BUFFER_LOW, type LinkState, type MediaLink } from '../net/link'

const ICE_GATHER_TIMEOUT_MS = 2500
const CONNECT_TIMEOUT_MS = 15_000
const BIN_BUFFER_HIGH = 1024 * 1024

type Ctl = { t: string; [k: string]: unknown }

export class MeshConn implements MediaLink {
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
  bytesSent = 0
  bytesReceived = 0

  onCtl: (msg: Ctl) => void = () => {}
  onMedia: (data: Uint8Array) => void = () => {}
  onBin: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  private pingSeq = 0
  private pongWaiters = new Map<number, { sentAt: number; resolve: (remoteClock: number) => void }>()
  private timeout: ReturnType<typeof setTimeout> | null = null

  constructor(
    iceServers: RTCIceServer[],
    /** Remote peer id (verified by whoever set up the connection). */
    public remoteId: string,
  ) {
    this.pc = new RTCPeerConnection({ iceServers })
    this.media = this.pc.createDataChannel('media', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: 1000 })
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true })
    this.bin = this.pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
    this.media.binaryType = 'arraybuffer'
    this.bin.binaryType = 'arraybuffer'
    this.media.bufferedAmountLowThreshold = LINK_BUFFER_LOW
    this.bin.bufferedAmountLowThreshold = BIN_BUFFER_HIGH / 4

    this.ctl.onopen = () => this.setState('open')
    this.ctl.onclose = () => this.setState('closed')
    this.media.onbufferedamountlow = () => this.onBufferLow()
    this.media.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer)
      this.bytesReceived += data.byteLength
      this.onMedia(data)
    }
    this.bin.onmessage = (ev) => this.onBin(new Uint8Array(ev.data as ArrayBuffer))
    this.ctl.onmessage = (ev) => {
      let msg: Ctl
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
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
    this.timeout = setTimeout(() => {
      if (this.state === 'connecting') this.setState('failed')
    }, ms)
  }

  /** Waits for ICE gathering (signaling is not trickled), bounded by a timeout. */
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
      this.bytesSent += data.byteLength
      return true
    } catch {
      return false
    }
  }

  sendCtl(msg: object): boolean {
    if (this.ctl.readyState !== 'open') return false
    try {
      this.ctl.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  /** The probe channel as a MediaLink, so probe traffic can share the uplink queue fairly. */
  get probeLink(): MediaLink {
    const bin = this.bin
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const conn = this
    return (this._probeLink ??= {
      get isOpen() {
        return bin.readyState === 'open'
      },
      get state() {
        return conn.state
      },
      get bufferedAmount() {
        return bin.bufferedAmount
      },
      send(data: Uint8Array) {
        if (bin.readyState !== 'open') return false
        try {
          bin.send(data as Uint8Array<ArrayBuffer>)
          return true
        } catch {
          return false
        }
      },
    })
  }
  private _probeLink: MediaLink | null = null

  /** Sends on the probe channel, waiting while its buffer is full. */
  async sendBin(data: Uint8Array): Promise<void> {
    if (this.bin.readyState !== 'open') throw new Error('not connected')
    if (this.bin.bufferedAmount > BIN_BUFFER_HIGH) {
      await new Promise<void>((r) => this.bin.addEventListener('bufferedamountlow', () => r(), { once: true }))
    }
    this.bin.send(data as Uint8Array<ArrayBuffer>)
  }

  /** Pings the remote; resolves with its wall clock (for clock sync), rejects on timeout. */
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

  /** Round-trip time of the selected candidate pair, if known. */
  async statsRttMs(): Promise<number | null> {
    try {
      const stats = await this.pc.getStats()
      let rtt: number | null = null
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') {
          rtt = r.currentRoundTripTime * 1000
        }
      })
      return rtt
    } catch {
      return null
    }
  }

  close(): void {
    this.setState('closed')
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed' || this.state === 'failed') return
    this.state = state
    if (state === 'open') this.wasOpen = true
    if (state !== 'connecting' && this.timeout !== null) clearTimeout(this.timeout)
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
