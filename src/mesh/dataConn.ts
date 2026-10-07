// What every connection between two peers has, whether it is the pair's mesh connection
// (meshConn.ts: adds the `ctl` channel) or one of its media lanes (lane.ts): an RTCPeerConnection
// with an unreliable `media` channel (fragments) and a reliable `bin` channel (headroom probes:
// session/headroom.ts; received bytes are dropped), and the same offer/answer handshake.
import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_LOW, type LinkState, type MediaLink, type ProbeLink } from '../net/link'
import { parseLinkStats, type StatsLike } from '../net/linkStats'
import { after } from '../net/ticker'
import { tuning } from '../tuning'

const ICE_GATHER_TIMEOUT_MS = 2500
export const CONNECT_TIMEOUT_MS = 15_000

/**
 * What the mesh, the lanes and the session use of any connection of a pair, so tests can substitute
 * in-memory ones (tests/fakes/).
 */
export interface PairConn extends MediaLink {
  readonly remoteId: string
  readonly state: LinkState
  readonly wasOpen: boolean
  /** The `bin` channel as a probe link (see session/headroom.ts). */
  readonly probeLink: ProbeLink
  onMedia: (data: Uint8Array) => void
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

/** Waits for ICE gathering (signaling is not trickled), bounded by a timeout; returns the local SDP. */
export async function gatherComplete(pc: RTCPeerConnection): Promise<string> {
  if (pc.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const cancel = after(ICE_GATHER_TIMEOUT_MS, resolve)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          cancel()
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

/** A reliable `bin` channel as a ProbeLink: its buffer-low events drive the probe's refills. */
function binProbeLink(bin: RTCDataChannel, state: () => LinkState): ProbeLink {
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

/**
 * The real connection, shared by MeshConn and Lane. Subclasses decide which channel opening opens
 * the connection (`setState('open')`).
 */
export abstract class DataConn implements PairConn {
  readonly pc: RTCPeerConnection
  readonly media: RTCDataChannel
  readonly bin: RTCDataChannel
  readonly probeLink: ProbeLink
  state: LinkState = 'connecting'
  /** Whether this connection was ever open (a failure before that means the pair can't connect). */
  wasOpen = false
  /** Whether the remote SDP arrived, so ICE was actually attempted. */
  haveRemote = false

  onMedia: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}

  private timeout: (() => void) | null = null

  constructor(
    iceServers: RTCIceServer[],
    /** Remote peer id (verified by whoever set up the connection). */
    public remoteId: string,
  ) {
    this.pc = new RTCPeerConnection({ iceServers })
    // Negotiated ids, the same on every connection (a mesh connection's ctl is id 1).
    this.media = this.pc.createDataChannel('media', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: tuning.mediaMaxPacketLifeTimeMs })
    this.bin = this.pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
    this.media.binaryType = 'arraybuffer'
    this.media.bufferedAmountLowThreshold = LINK_BUFFER_LOW
    this.bin.binaryType = 'arraybuffer'
    this.bin.bufferedAmountLowThreshold = BACKGROUND_BUFFER_MAX / 2
    this.probeLink = binProbeLink(this.bin, () => this.state)
    this.media.onbufferedamountlow = () => this.onBufferLow()
    this.media.onmessage = (ev) => this.onMedia(new Uint8Array(ev.data as ArrayBuffer))
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

  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer())
    return gatherComplete(this.pc)
  }

  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp })
    this.haveRemote = true
    this.armTimeout()
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    return gatherComplete(this.pc)
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
    this.haveRemote = true
    this.armTimeout()
  }

  /** Whether the selected candidate pair goes through a TURN relay (null: unknown). */
  async usesRelay(): Promise<boolean | null> {
    const report = await this.stats()
    return (report && parseLinkStats(report)?.relayed) ?? null
  }

  stats(): Promise<StatsLike | null> {
    return connStats(this.pc)
  }

  close(): void {
    this.setState('closed')
  }

  protected setState(state: LinkState): void {
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
