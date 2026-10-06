// What the uplink and relay need from a peer link. Media fragments travel over each mesh
// connection's unordered, partially reliable `media` data channel (mesh/meshConn.ts).

export type LinkState = 'connecting' | 'open' | 'closed' | 'failed'

/** Send-buffer watermarks for a media channel. */
export const LINK_BUFFER_HIGH = 512 * 1024
export const LINK_BUFFER_LOW = 128 * 1024

export interface MediaLink {
  readonly isOpen: boolean
  readonly state: LinkState
  readonly bufferedAmount: number
  /** Sends one message. Returns false if the link is not open. */
  send(data: Uint8Array): boolean
}
