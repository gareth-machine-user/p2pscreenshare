// The media side of a mesh connection (meshConn.ts adds the `ctl` channel): an RTCPeerConnection
// whose fragments and headroom-probe bytes ride in a VP8 carrier track (carrierLink.ts), and the
// offer/answer handshake that puts the carrier in the first SDP.
import type { LinkState, MediaLink, ProbeLink } from '../net/link'
import { parseLinkStats, type StatsLike } from '../net/linkStats'
import { after } from '../net/ticker'
import { carrierConfig, CarrierLink, IncompatiblePeerError } from './carrierLink'

const ICE_GATHER_TIMEOUT_MS = 2500
export const CONNECT_TIMEOUT_MS = 15_000

/**
 * What the mesh and the session use of a connection's media side, so tests can substitute in-memory
 * ones (tests/fakes/).
 */
export interface PairConn extends MediaLink {
  readonly remoteId: string
  readonly state: LinkState
  readonly wasOpen: boolean
  /** Padding in the carrier, as a probe link (see session/headroom.ts). */
  readonly probeLink: ProbeLink
  /**
   * The most it sends (kbps), if it limits itself (the carrier: carrierCapKbps for the round trip): its capacity is
   * the browser's estimate, at most this.
   */
  readonly maxKbps?: number
  onMedia: (data: Uint8Array) => void
  onStateChange: (state: LinkState) => void
  onBufferLow: () => void
  /** The remote runs an incompatible version (the connection is then refused). */
  onIncompatible?: () => void
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

/** The real connection's media side; MeshConn decides when it opens (its `ctl` channel). */
export abstract class DataConn implements PairConn {
  readonly pc: RTCPeerConnection
  readonly carrier: CarrierLink
  readonly probeLink: ProbeLink
  state: LinkState = 'connecting'
  /** Whether this connection was ever open (a failure before that means the pair can't connect). */
  wasOpen = false
  /** Whether the remote SDP arrived, so ICE was actually attempted. */
  haveRemote = false

  onMedia: (data: Uint8Array) => void = () => {}
  onStateChange: (state: LinkState) => void = () => {}
  onBufferLow: () => void = () => {}
  onIncompatible: () => void = () => {}

  private timeout: (() => void) | null = null

  constructor(
    iceServers: RTCIceServer[],
    /** Remote peer id (verified by whoever set up the connection). */
    public remoteId: string,
  ) {
    this.pc = new RTCPeerConnection({ iceServers, ...carrierConfig() })
    this.carrier = new CarrierLink(
      this.pc,
      () => this.isOpen,
      () => this.state,
      () => this.setState('failed'),
    )
    this.carrier.onMedia = (data) => this.onMedia(data)
    this.carrier.onBufferLow = () => this.onBufferLow()
    this.probeLink = this.carrier.probeLink
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'connected') this.carrier.start()
      else if (s === 'failed') this.setState('failed')
      else if (s === 'closed') this.setState('closed')
    }
  }

  get isOpen(): boolean {
    return this.state === 'open'
  }

  /** Bytes handed to the carrier and not yet in a frame. */
  get bufferedAmount(): number {
    return this.carrier.bufferedAmount
  }

  /** Sends a media fragment in the carrier. */
  send(data: Uint8Array): boolean {
    return this.carrier.send(data)
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
    this.carrier.addForOffer()
    await this.pc.setLocalDescription(await this.pc.createOffer())
    return gatherComplete(this.pc)
  }

  async acceptOffer(sdp: string): Promise<string> {
    this.carrier.addForAnswer()
    await this.pc.setRemoteDescription({ type: 'offer', sdp: this.carrier.remoteSdp(sdp) })
    this.haveRemote = true
    this.armTimeout()
    this.checked(() => this.carrier.afterRemoteOffer(sdp))
    await this.pc.setLocalDescription(await this.pc.createAnswer())
    return gatherComplete(this.pc)
  }

  async acceptAnswer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: this.carrier.remoteSdp(sdp) })
    this.haveRemote = true
    this.armTimeout()
    this.checked(() => this.carrier.afterRemoteAnswer(sdp))
  }

  /** Runs a compatibility check: an incompatible peer is reported, then thrown (the caller closes). */
  protected checked(check: () => void): void {
    try {
      check()
    } catch (err) {
      if (err instanceof IncompatiblePeerError) this.onIncompatible()
      throw err
    }
  }

  /** Whether the selected candidate pair goes through a TURN relay (null: unknown). */
  async usesRelay(): Promise<boolean | null> {
    const report = await this.stats()
    return (report && parseLinkStats(report)?.relayed) ?? null
  }

  get maxKbps(): number {
    return this.carrier.maxKbps
  }

  get bufferHigh(): number {
    return this.carrier.bufferHigh
  }

  /** The getStats() report; its bandwidth estimate also sets the carrier's send rate. */
  async stats(): Promise<StatsLike | null> {
    const report = await connStats(this.pc)
    if (report) this.carrier.noteStats(report)
    return report
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
      this.carrier.close()
      try {
        this.pc.close()
      } catch {
        // already closed
      }
    }
    this.onStateChange(state)
  }
}
