// What the uplink and relay need from a peer link. Media fragments travel over each mesh
// connection's unordered, partially reliable `media` data channel (mesh/meshConn.ts).

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

/**
 * Send-buffer watermarks for a media channel. Small on purpose: time spent in the channel's own
 * buffer is invisible to the uplink's per-layer deadlines and queue-delay stats, so the backlog
 * should build in the uplink queue instead. 256 KiB is ~50-100 ms at 20-40 Mbps (field reports
 * found ~256 KiB per connection about optimal); the low mark keeps the 4:1 ratio.
 */
export const LINK_BUFFER_HIGH = 256 * 1024
export const LINK_BUFFER_LOW = 64 * 1024

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
