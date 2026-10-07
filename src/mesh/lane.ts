// A media lane: an extra RTCPeerConnection between two mesh peers that carries only media (and
// probe) traffic. Every WebRTC connection is one SCTP association with its own Reno-like
// congestion window, which tops out at roughly 10-25 Mbps on real WAN paths; spreading a pair's
// stripes over several associations raises that ceiling (see lanes.ts for how lanes are opened
// and used). A lane has no `ctl` channel: its signaling runs over the pair's mesh connection.
import { DataConn, type PairConn } from './dataConn'

/** What the mesh uses of a lane, so tests can substitute an in-memory one (tests/fakes/). */
export interface LaneConn extends PairConn {
  /** 1..MAX_LANES-1 (lane 0 is the mesh connection itself). */
  readonly index: number
}

export type LaneFactory = (iceServers: RTCIceServer[], remoteId: string, index: number) => LaneConn

export class Lane extends DataConn implements LaneConn {
  constructor(
    iceServers: RTCIceServer[],
    remoteId: string,
    readonly index: number,
  ) {
    super(iceServers, remoteId)
    // No ctl channel: the lane is open once its media channel is.
    this.media.onopen = () => this.setState('open')
    this.media.onclose = () => this.setState('closed')
  }
}
