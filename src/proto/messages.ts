// Control-plane messages, exchanged as JSON over mesh links (`ctl` channel) between subscribers and
// the publisher of the channel they watch, plus the upload probe between neighbours. Tree commands
// for a channel are only accepted from that channel's publisher.
import type { Topology } from '../topology/model'

export interface StreamInfo {
  epoch: number
  codec: string
  codedWidth: number
  codedHeight: number
  /** Base64 decoder description (avcC etc.), when the codec needs one. */
  description?: string
  audio?: { codec: string; sampleRate: number; numberOfChannels: number }
}

export interface StripeStat {
  parent: string | null
  /** ms since the last fragment on this stripe (null if never). */
  lastRecvAgoMs: number | null
  rttMs: number | null
  /** How much later than the earliest stripe this stripe's pieces arrive, smoothed (ms). */
  lateMs: number
}

/** A subscriber's report to the channel's publisher, every 2 s. */
export interface SubscriberStats {
  /** Debug upload cap, if any. */
  capKbps: number | null
  capacityKbps: number | null
  uplinkKbps: number
  uplinkDropRate: number
  stripes: StripeStat[]
  children: number
  latencyMs: number | null
  bufferMs: number
  fps: number
  decodedFrames: number
  droppedFrames: number
  waitingForKeyframe: boolean
}

/** What a publisher knows about one channel's trees (Topology panel). */
export interface TopologyReport {
  channel: number
  publisher: string
  k: number
  m: number
  topology: Topology
  depth: Record<string, number[]>
  slots: Record<string, number>
  rootSlots: number
  overcommitted: number
  changes: number
  peers: { id: string; failures: number; avoid: string[]; stats: SubscriberStats | null }[]
}

export type SubscriberMsg =
  | { t: 'subscribe'; ch: number }
  | { t: 'unsubscribe'; ch: number }
  | { t: 'stripe-ok'; ch: number; stripe: number; parent: string }
  /** linkOpen: whether the link to the current parent is up (if so, the parent is failing to forward). */
  | { t: 'reattach'; ch: number; stripe: number; linkOpen: boolean }
  | { t: 'need-key'; ch: number }
  | { t: 'stats'; ch: number; stats: SubscriberStats }
  /** Ask for (or stop) topology reports while the panel is open. */
  | { t: 'topo-req'; ch: number; on: boolean }

export type PublisherMsg =
  | { t: 'set-parent'; ch: number; stripe: number; parent: string | null }
  | { t: 'add-child'; ch: number; stripe: number; child: string }
  | { t: 'remove-child'; ch: number; stripe: number; child: string }
  | { t: 'position'; ch: number; home: number | null; depth: number[] }
  /** Gzipped TopologyReport (base64url), at most every 3 s while requested. */
  | { t: 'topo'; ch: number; z: string }
  /** The channel is overcommitted: please re-measure your upload (estimates may be stale). */
  | { t: 'reprobe'; ch: number }

export type PeerMsg =
  | SubscriberMsg
  | PublisherMsg
  /** A member asks the owner for the right to publish. */
  | { t: 'publish-req' }
  /** The owner said no (or the policy is closed). */
  | { t: 'publish-deny' }
  /** End of an upload probe (sent on the reliable channel, outside the uplink queue). */
  | { t: 'probe-end'; id: number }
  /** A neighbour's report of a probe it received from us: bytes, over its arrival window. */
  | { t: 'probe-result'; bytes: number; ms: number }

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
