// A WebRTC link between two peers carrying media fragments on one unordered, partially reliable
// data channel. Signaling is delivered out of band (host-relayed) via `sendSignal`/`handleSignal`.

export type LinkSignal =
  | { type: 'sdp'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit | null }

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

export interface LinkOptions {
  remoteId: string
  /** The offerer creates the SDP offer; the other side answers. */
  offerer: boolean
  rtcConfig: RTCConfiguration
  sendSignal: (signal: LinkSignal) => void
  connectTimeoutMs?: number
}

export const LINK_BUFFER_HIGH = 512 * 1024
export const LINK_BUFFER_LOW = 128 * 1024

export class PeerLink {
  readonly remoteId: string
  readonly pc: RTCPeerConnection
  readonly channel: RTCDataChannel
  state: LinkState = 'connecting'
  readonly createdAt = performance.now()
  bytesSent = 0
  bytesReceived = 0

  onMessage: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  private pendingCandidates: RTCIceCandidateInit[] = []
  private timeout: ReturnType<typeof setTimeout>
  private opts: LinkOptions

  constructor(opts: LinkOptions) {
    this.opts = opts
    this.remoteId = opts.remoteId
    this.pc = new RTCPeerConnection(opts.rtcConfig)
    this.channel = this.pc.createDataChannel('media', {
      negotiated: true,
      id: 0,
      ordered: false,
      maxPacketLifeTime: 1000,
    })
    this.channel.binaryType = 'arraybuffer'
    this.channel.bufferedAmountLowThreshold = LINK_BUFFER_LOW
    this.channel.onopen = () => this.setState('open')
    this.channel.onclose = () => this.setState('closed')
    this.channel.onbufferedamountlow = () => this.onBufferLow()
    this.channel.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer)
      this.bytesReceived += data.byteLength
      this.onMessage(data)
    }
    this.pc.onicecandidate = (ev) => opts.sendSignal({ type: 'ice', candidate: ev.candidate?.toJSON() ?? null })
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.setState('failed')
      if (this.pc.connectionState === 'closed') this.setState('closed')
    }
    this.timeout = setTimeout(() => {
      if (this.state === 'connecting') this.setState('failed')
    }, opts.connectTimeoutMs ?? 12_000)

    if (opts.offerer) void this.makeOffer()
  }

  private async makeOffer(): Promise<void> {
    try {
      const offer = await this.pc.createOffer()
      await this.pc.setLocalDescription(offer)
      this.opts.sendSignal({ type: 'sdp', sdp: this.pc.localDescription!.toJSON() })
    } catch (err) {
      console.warn('link offer failed', err)
      this.setState('failed')
    }
  }

  async handleSignal(signal: LinkSignal): Promise<void> {
    if (this.state === 'closed' || this.state === 'failed') return
    try {
      if (signal.type === 'sdp') {
        await this.pc.setRemoteDescription(signal.sdp)
        for (const c of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(c)
        if (signal.sdp.type === 'offer') {
          const answer = await this.pc.createAnswer()
          await this.pc.setLocalDescription(answer)
          this.opts.sendSignal({ type: 'sdp', sdp: this.pc.localDescription!.toJSON() })
        }
      } else if (signal.candidate) {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(signal.candidate)
        else this.pendingCandidates.push(signal.candidate)
      }
    } catch (err) {
      console.warn('link signal failed', err)
    }
  }

  get isOpen(): boolean {
    return this.state === 'open' && this.channel.readyState === 'open'
  }

  get bufferedAmount(): number {
    return this.channel.bufferedAmount
  }

  /** Sends one message. Returns false if the link is not open. */
  send(data: Uint8Array): boolean {
    if (!this.isOpen) return false
    try {
      this.channel.send(data as Uint8Array<ArrayBuffer>)
      this.bytesSent += data.byteLength
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.setState('closed')
  }

  private setState(state: LinkState): void {
    if (this.state === state || this.state === 'closed' || this.state === 'failed') return
    this.state = state
    if (state !== 'connecting') clearTimeout(this.timeout)
    if (state === 'closed' || state === 'failed') {
      try {
        this.channel.close()
        this.pc.close()
      } catch {
        // already closed
      }
    }
    this.onStateChange(state)
  }

  /** Round-trip time of the selected candidate pair, if known. */
  async rttMs(): Promise<number | null> {
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
}
