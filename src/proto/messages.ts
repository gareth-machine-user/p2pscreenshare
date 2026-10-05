// Control-plane messages, exchanged as JSON between each viewer and the host.
import type { LinkSignal } from '../net/link'

export interface StreamInfo {
  epoch: number
  codec: string
  codedWidth: number
  codedHeight: number
  /** Base64 decoder description (avcC etc.), when the codec needs one. */
  description?: string
  audio?: { codec: string; sampleRate: number; numberOfChannels: number }
}

export interface StreamConfig {
  k: number
  m: number
  bitrateKbps: number
}

export interface StripeStat {
  parent: string | null
  /** ms since the last fragment on this stripe (null if never). */
  lastRecvAgoMs: number | null
  rttMs: number | null
}

export interface ViewerStats {
  /** Measured upload capacity from the probe (kbps), null until measured. */
  probeKbps: number | null
  /** Debug upload cap, if any. */
  capKbps: number | null
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

export type ViewerToHost =
  | { t: 'hello'; name: string; capKbps: number | null }
  | { t: 'stats'; stats: ViewerStats }
  | { t: 'signal'; to: string; signal: LinkSignal }
  | { t: 'stripe-ok'; stripe: number; parent: string }
  | { t: 'link-failed'; remote: string }
  /** linkOpen: whether the link to the current parent is up (if so, the parent is failing to forward). */
  | { t: 'reattach'; stripe: number; linkOpen: boolean }
  | { t: 'need-key' }
  | { t: 'probe-start'; bytes: number }

export type HostToViewer =
  | { t: 'welcome'; config: StreamConfig; stream: StreamInfo | null }
  | { t: 'stream'; stream: StreamInfo }
  | { t: 'set-parent'; stripe: number; parent: string | null }
  | { t: 'add-child'; stripe: number; child: string }
  | { t: 'remove-child'; stripe: number; child: string }
  | { t: 'signal'; from: string; signal: LinkSignal }
  | { t: 'probe-result'; kbps: number }
  | { t: 'position'; home: number | null; depth: number[] }

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
