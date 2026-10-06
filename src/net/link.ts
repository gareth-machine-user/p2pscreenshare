// What the uplink and relay need from a peer link. Media fragments travel over each mesh
// connection's unordered, partially reliable `media` data channel (mesh/meshConn.ts).

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

/**
 * Send-buffer watermarks for a media channel. Small on purpose:
 * - Time spent in the channel's own buffer is invisible to the uplink's per-layer deadlines, so the
 *   backlog should build in the uplink queue instead.
 * - What sits in the buffer goes out in bursts as large as SCTP's congestion window, which grows
 *   big on a fast, low-RTT path (two tabs on one machine above all). Chromium's UDP sockets for
 *   WebRTC have 64 KB send and receive buffers (Linux doubles that): a bigger burst overflows them,
 *   the packets are lost (getStats packetsDiscardedOnSend), and SCTP recovers the tail by
 *   retransmission timeout, ≥ ~400 ms and doubling, during which the whole association, ctl
 *   included, delivers nothing. Measured with e2e/diag-sctp.spec.ts on loopback: 256 KiB buffered
 *   stalled a fresh association for 0.8-1.6 s in 4 of 4 runs, 64 KiB in 0 of 3 (one run with two
 *   isolated 0.4 s gaps in 4 more), at the same throughput (~270-290 Mbps per connection).
 * bufferedAmount counts bytes not yet handed to SCTP's packets (in-flight data isn't in it), so it
 * needn't cover the path's bandwidth-delay product; the low mark refills it on an event.
 */
export const LINK_BUFFER_HIGH = 64 * 1024
export const LINK_BUFFER_LOW = 16 * 1024

export interface MediaLink {
  readonly isOpen: boolean
  readonly state: LinkState
  readonly bufferedAmount: number
  /** Sends one message. Returns false if the link is not open. */
  send(data: Uint8Array): boolean
}

/**
 * A neighbour's probe channel (the reliable `bin` channel): a MediaLink that also reports when
 * its send buffer drains, so the upload probe refills it from events, not timers (which a hidden
 * tab throttles).
 */
export interface ProbeLink extends MediaLink {
  /** Called whenever the send buffer falls to `bufferLowThreshold` or below. */
  onBufferLow: (() => void) | null
  /** Bytes. */
  bufferLowThreshold: number
}
