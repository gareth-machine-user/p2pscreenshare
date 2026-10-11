// What the uplink and relay need from a peer link. Media fragments travel in the carrier video
// track of each mesh connection (mesh/carrierLink.ts).

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

/**
 * Send-buffer watermarks for a link: the bytes handed to its carrier and not yet packed into a
 * frame. Small on purpose: time spent there is invisible to the uplink's per-layer deadlines (and
 * its priorities), so the backlog should build in the uplink queue instead, where late fragments
 * are dropped and live ones go first. The carrier packs at the browser's estimate (64 KiB is ~26 ms
 * at 20 Mbps, ~0.5 s at 1 Mbps), and the low mark refills it on an event.
 */
export const LINK_BUFFER_HIGH = 64 * 1024
export const LINK_BUFFER_LOW = 16 * 1024
/**
 * Low-priority data (GOP-cache replays, headroom probes) is only handed to a link while its send
 * buffer holds less than this (bytes): it shares the carrier with live media.
 */
export const BACKGROUND_BUFFER_MAX = 64 * 1024

export interface MediaLink {
  readonly isOpen: boolean
  readonly state: LinkState
  readonly bufferedAmount: number
  /** Sends one message. Returns false if the link is not open. */
  send(data: Uint8Array): boolean
}

/**
 * A neighbour's probe link (padding in its carrier, mesh/carrierLink.ts): a MediaLink that also
 * reports when its send buffer drains, so the headroom probe refills it from events, not timers (which a hidden
 * tab throttles).
 */
export interface ProbeLink extends MediaLink {
  /** Called whenever the send buffer falls to half of BACKGROUND_BUFFER_MAX or below. */
  onBufferLow: (() => void) | null
}
