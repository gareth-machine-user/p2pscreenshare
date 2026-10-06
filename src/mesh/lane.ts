// A media lane: an extra RTCPeerConnection between two mesh peers that carries only media (and
// probe) traffic. Every WebRTC connection is one SCTP association with its own Reno-like
// congestion window, which tops out at roughly 10-25 Mbps on real WAN paths; spreading a pair's
// stripes over several associations raises that ceiling (see lanes.ts for how lanes are opened
// and used). A lane has no `ctl` channel: its signaling runs over the pair's mesh connection.
import { LINK_BUFFER_LOW, type LinkState, type MediaLink, type ProbeLink } from '../net/link'
import { tuning } from '../tuning'
import type { StatsLike } from '../net/linkStats'
import { binProbeLink, connStats, CONNECT_TIMEOUT_MS, gatherComplete } from './meshConn'

const BIN_BUFFER_LOW = 256 * 1024

/** What the mesh uses of a lane, so tests can substitute an in-memory one (tests/fakes/). */
export interface LaneConn extends MediaLink {
  readonly remoteId: string
  /** 1..MAX_LANES-1 (lane 0 is the mesh connection itself). */
  readonly index: number
  readonly probeLink: ProbeLink
  onMedia: (data: Uint8Array) => void
  onBin: (data: Uint8Array) => void
  onStateChange: (state: LinkState) => void
  onBufferLow: () => void
  armTimeout(ms?: number): void
  createOffer(): Promise<string>
  acceptOffer(sdp: string): Promise<string>
  acceptAnswer(sdp: string): Promise<void>
  /** The connection's getStats() report (absent in tests' fakes; null when closed). */
  stats?(): Promise<StatsLike | null>
  close(): void
}

export type LaneFactory = (iceServers: RTCIceServer[], remoteId: string, index: number) => LaneConn

export class Lane implements LaneConn {
  readonly pc: RTCPeerConnection
  readonly media: RTCDataChannel
  readonly bin: RTCDataChannel
  state: LinkState = 'connecting'
  bytesSent = 0
  bytesReceived = 0

  onMedia: (data: Uint8Array) => void = () => {}
  onBin: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  private timeout: ReturnType<typeof setTimeout> | null = null
  private _probeLink: ProbeLink | null = null

  constructor(
    iceServers: RTCIceServer[],
    readonly remoteId: string,
    readonly index: number,
  ) {
    this.pc = new RTCPeerConnection({ iceServers })
    // The same channel settings as the mesh connection's media and bin channels.
    this.media = this.pc.createDataChannel('media', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: tuning.mediaMaxPacketLifeTimeMs })
    this.bin = this.pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
    this.media.binaryType = 'arraybuffer'
    this.bin.binaryType = 'arraybuffer'
    this.media.bufferedAmountLowThreshold = LINK_BUFFER_LOW
    this.bin.bufferedAmountLowThreshold = BIN_BUFFER_LOW
    this.media.onopen = () => this.setState('open')
    this.media.onclose = () => this.setState('closed')
    this.media.onbufferedamountlow = () => this.onBufferLow()
    this.media.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer)
      this.bytesReceived += data.byteLength
      this.onMedia(data)
    }
    this.bin.onmessage = (ev) => this.onBin(new Uint8Array(ev.data as ArrayBuffer))
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.setState('failed')
      if (this.pc.connectionState === 'closed') this.setState('closed')
    }
  }

  get isOpen(): boolean {
    return this.state === 'open' && this.media.readyState === 'open'
  }

  get bufferedAmount(): number {
    return this.media.bufferedAmount
  }

  get probeLink(): ProbeLink {
    this._probeLink ??= binProbeLink(this.bin, () => this.state)
    return this._probeLink
  }

  send(data: Uint8Array): boolean {
    if (!this.isOpen) return false
    try {
      this.media.send(data as Uint8Array<ArrayBuffer>)
      this.bytesSent += data.byteLength
      return true
    } catch {
      // closed between the check and the send
      return false
    }
  }

  armTimeout(ms = CONNECT_TIMEOUT_MS): void {
    if (this.timeout !== null || this.state !== 'connecting') return
    this.timeout = setTimeout(() => {
      if (this.state === 'connecting') this.setState('failed')
    }, ms)
  }

  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    return gatherComplete(this.pc)
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    this.armTimeout()
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    return gatherComplete(this.pc)
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
    this.armTimeout()
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
