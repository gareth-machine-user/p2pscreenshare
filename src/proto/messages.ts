// Control-plane messages, exchanged as JSON over mesh links (`ctl` channel) between subscribers and
// the publisher of the channel they watch, plus the upload probe between neighbours. Tree commands
// for a channel are only accepted from that channel's publisher.
import type { Topology } from '../topology/model'

// Re-exported for the media pipeline (decoder descriptions).
export { fromBase64, toBase64 } from '../util/base64'

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

/** Where a viewer's frames went missing, per second over the last stats window. */
export interface LossRates {
  /** Frames that became decodable (k pieces arrived). */
  incomingFps: number
  /** Frames dropped without ever getting k complete pieces (fragments lost or dropped upstream). */
  incomplete: number
  /** Frames that arrived after their play time. */
  late: number
  /** Frames whose reference frame was missing. */
  undecodable: number
  /** Frames given up on while waiting for a missing one. */
  skipped: number
  /** Decoded frames replaced by a newer one before they could be shown. */
  notRendered: number
}

/** A peer's uplink, per second over the last stats window. */
export interface UplinkRates {
  kbps: number
  /** Media fragments dropped for missing their queueing deadline, by temporal layer T0, T1, T2. */
  drops: [number, number, number]
  /** Send-buffer stalls (a child's data channel was full). */
  stalls: number
  /** Average time sent fragments waited in the queue (ms). */
  queueMs: number
}

/** A publisher's encoder, per second over the last stats window. */
export interface EncoderRates {
  codec: string | null
  /** Current encoder target, and the most it may go up to (the chosen quality preset). */
  targetKbps: number
  ceilingKbps: number
  kbps: number
  captureFps: number
  encodedFps: number
  /** Captured frames dropped because the encoder was behind. */
  droppedFps: number
  keyframes: number
  /** Smoothed encode time per frame (ms). */
  encodeMs: number
  /** Largest frame in the window (KB). */
  maxFrameKB: number
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
  loss?: LossRates
  uplinkRates?: UplinkRates
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
  /**
   * (peer, stripe) pairs the last plan left without a parent because nothing could link to the peer
   * (PlanResult.unattached). Absent from older publishers.
   */
  unattached?: number
  changes: number
  peers: {
    id: string
    failures: number
    avoid: string[]
    stats: SubscriberStats | null
    /**
     * The publisher's own link to this peer, if it feeds it directly: drops/s, queueing, whether it
     * was backlogged, and what its connections carry (session/capacity.ts; null until measured).
     */
    link?: { drops: number; queueMs: number; backlogged: boolean; capKbps: number | null } | null
  }[]
  /** The publisher's own encoder and uplink. */
  publisherStats?: { encoder: EncoderRates | null; uplink: UplinkRates | null }
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
  | { t: 'position'; ch: number; homes: number[]; depth: number[] }
  /** Gzipped TopologyReport (base64url), at most every 3 s while requested. */
  | { t: 'topo'; ch: number; z: string }

export type PeerMsg =
  | SubscriberMsg
  | PublisherMsg
  /** A member asks the owner for the right to publish. */
  | { t: 'publish-req' }
  /** The owner said no (or the policy is closed). */
  | { t: 'publish-deny' }
  /** The member withdrew its request (the owner drops it). */
  | { t: 'publish-cancel' }
  /**
   * A subscriber whose decode chain broke asks its parent on these stripes (a relay, or the
   * publisher) to replay its cached GOP, before escalating to `need-key` for everyone.
   */
  | { t: 'need-gop'; ch: number; stripes: number[] }

/** Every message type, once: the runtime lists below must match the unions (checked at compile time). */
export const SUBSCRIBER_MSG_TYPES = ['subscribe', 'unsubscribe', 'stripe-ok', 'reattach', 'need-key', 'stats', 'topo-req'] as const satisfies readonly SubscriberMsg['t'][]
export const PUBLISHER_MSG_TYPES = ['set-parent', 'add-child', 'remove-child', 'position', 'topo'] as const satisfies readonly PublisherMsg['t'][]
export const PEER_MSG_TYPES = [
  ...SUBSCRIBER_MSG_TYPES,
  ...PUBLISHER_MSG_TYPES,
  'publish-req',
  'publish-deny',
  'publish-cancel',
  'need-gop',
] as const satisfies readonly PeerMsg['t'][]

// Fails to compile if a union gains a type the lists above miss.
type Missing<All, Listed> = Exclude<All, Listed> extends never ? true : Exclude<All, Listed>
const _listsComplete: [Missing<SubscriberMsg['t'], (typeof SUBSCRIBER_MSG_TYPES)[number]>, Missing<PublisherMsg['t'], (typeof PUBLISHER_MSG_TYPES)[number]>, Missing<PeerMsg['t'], (typeof PEER_MSG_TYPES)[number]>] = [true, true, true]
void _listsComplete

const subscriberTypes: ReadonlySet<string> = new Set(SUBSCRIBER_MSG_TYPES)
const publisherTypes: ReadonlySet<string> = new Set(PUBLISHER_MSG_TYPES)

export function isSubscriberMsg(msg: PeerMsg): msg is SubscriberMsg {
  return subscriberTypes.has(msg.t)
}

export function isPublisherMsg(msg: PeerMsg): msg is PublisherMsg {
  return publisherTypes.has(msg.t)
}

// --- validation of untrusted peer input ------------------------------------------------------------
// Peers are only as trusted as their signature: a message is dispatched only if it has the shape its
// handlers rely on. Extra fields are ignored; fields only shown in the UI are checked loosely.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const isNumOrNull = (v: unknown) => v === null || isNum(v)
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string'
/** More stripes than any channel has (k + m); bounds lists of stripe indices. */
const MAX_STRIPES = 64
const isNumArray = (v: unknown, len?: number) => Array.isArray(v) && (len === undefined || v.length === len) && v.every(isNum)

function isStripeStat(v: unknown): v is StripeStat {
  return isObj(v) && isStrOrNull(v.parent) && isNum(v.lateMs) && isNumOrNull(v.lastRecvAgoMs) && isNumOrNull(v.rttMs)
}

function isLossRates(v: unknown): v is LossRates {
  return isObj(v) && ['incomingFps', 'incomplete', 'late', 'undecodable', 'skipped', 'notRendered'].every((k) => isNum(v[k]))
}

function isUplinkRates(v: unknown): v is UplinkRates {
  return isObj(v) && isNum(v.kbps) && isNumArray(v.drops, 3) && isNum(v.stalls) && isNum(v.queueMs)
}

const ENCODER_RATE_FIELDS = ['targetKbps', 'ceilingKbps', 'kbps', 'captureFps', 'encodedFps', 'droppedFps', 'keyframes', 'encodeMs', 'maxFrameKB'] as const

function isEncoderRates(v: unknown): v is EncoderRates {
  return isObj(v) && isStrOrNull(v.codec) && ENCODER_RATE_FIELDS.every((k) => isNum(v[k]))
}

/** A publisher's own link to a peer, as a TopologyReport carries it. */
function isPeerLink(v: unknown): boolean {
  return isObj(v) && isNum(v.drops) && isNum(v.queueMs) && typeof v.backlogged === 'boolean' && isNumOrNull(v.capKbps)
}

export function isSubscriberStats(v: unknown): v is SubscriberStats {
  return (
    isObj(v) &&
    Array.isArray(v.stripes) &&
    v.stripes.every(isStripeStat) &&
    isNumOrNull(v.capKbps) &&
    isNumOrNull(v.capacityKbps) &&
    isNum(v.uplinkKbps) &&
    isNum(v.uplinkDropRate) &&
    isNum(v.children) &&
    isNumOrNull(v.latencyMs) &&
    isNum(v.bufferMs) &&
    isNum(v.fps) &&
    isNum(v.decodedFrames) &&
    isNum(v.droppedFrames) &&
    typeof v.waitingForKeyframe === 'boolean' &&
    (v.loss === undefined || isLossRates(v.loss)) &&
    (v.uplinkRates === undefined || isUplinkRates(v.uplinkRates))
  )
}

/**
 * Subscriber stats are telemetry the sender computes from rates and averages, so a NaN or Infinity
 * (null after JSON) is a hiccup, not an attack: rather than dropping the whole report (and with it
 * the stripe lateness the publisher plans with), bad scalars are repaired. Only a broken structure
 * (no stripes list, a non-string parent) rejects it.
 */
export function sanitizeSubscriberStats(v: unknown): SubscriberStats | null {
  if (!isObj(v) || !Array.isArray(v.stripes)) return null
  const num = (x: unknown) => (isNum(x) ? x : 0)
  const numOrNull = (x: unknown) => (isNum(x) ? x : null)
  const stripes: StripeStat[] = []
  for (const st of v.stripes) {
    if (!isObj(st) || !isStrOrNull(st.parent)) return null
    stripes.push({ parent: st.parent as string | null, lastRecvAgoMs: numOrNull(st.lastRecvAgoMs), rttMs: numOrNull(st.rttMs), lateMs: num(st.lateMs) })
  }
  return {
    capKbps: numOrNull(v.capKbps),
    capacityKbps: numOrNull(v.capacityKbps),
    uplinkKbps: num(v.uplinkKbps),
    uplinkDropRate: num(v.uplinkDropRate),
    stripes,
    children: num(v.children),
    latencyMs: numOrNull(v.latencyMs),
    bufferMs: num(v.bufferMs),
    fps: num(v.fps),
    decodedFrames: num(v.decodedFrames),
    droppedFrames: num(v.droppedFrames),
    waitingForKeyframe: v.waitingForKeyframe === true,
    loss: isLossRates(v.loss) ? v.loss : undefined,
    uplinkRates: isUplinkRates(v.uplinkRates) ? v.uplinkRates : undefined,
  }
}

/** Per type: the fields beyond `t` that must be present and well-formed. */
const shapes: { [T in PeerMsg['t']]: (m: Obj) => boolean } = {
  subscribe: (m) => isNum(m.ch),
  unsubscribe: (m) => isNum(m.ch),
  'stripe-ok': (m) => isNum(m.ch) && isIndex(m.stripe) && typeof m.parent === 'string',
  reattach: (m) => isNum(m.ch) && isIndex(m.stripe) && typeof m.linkOpen === 'boolean',
  'need-key': (m) => isNum(m.ch),
  stats: (m) => {
    // Repaired in place (see sanitizeSubscriberStats).
    const stats = isNum(m.ch) ? sanitizeSubscriberStats(m.stats) : null
    if (stats) m.stats = stats
    return stats !== null
  },
  'topo-req': (m) => isNum(m.ch) && typeof m.on === 'boolean',
  'set-parent': (m) => isNum(m.ch) && isIndex(m.stripe) && isStrOrNull(m.parent),
  'add-child': (m) => isNum(m.ch) && isIndex(m.stripe) && typeof m.child === 'string',
  'remove-child': (m) => isNum(m.ch) && isIndex(m.stripe) && typeof m.child === 'string',
  position: (m) => isNum(m.ch) && Array.isArray(m.homes) && m.homes.every(isIndex) && isNumArray(m.depth),
  topo: (m) => isNum(m.ch) && typeof m.z === 'string',
  'publish-req': () => true,
  'publish-deny': () => true,
  'publish-cancel': () => true,
  // Bounded: a parent serves at most one replay per stripe anyway.
  'need-gop': (m) => isNum(m.ch) && Array.isArray(m.stripes) && m.stripes.length > 0 && m.stripes.length <= MAX_STRIPES && m.stripes.every(isIndex),
}

/** Returns the message if it is a well-formed PeerMsg, else null (a buggy or hostile peer). */
export function parsePeerMsg(v: unknown): PeerMsg | null {
  if (!isObj(v) || typeof v.t !== 'string' || !Object.hasOwn(shapes, v.t)) return null
  return shapes[v.t as PeerMsg['t']](v) ? (v as PeerMsg) : null
}

/**
 * Checks a decoded TopologyReport: the fields the Topology panel dereferences. Display-only extras
 * that are malformed (the publisher's own stats, a peer's link, the unattached count) are dropped in place rather than
 * rejecting the report, as a NaN in them (null after JSON) is a hiccup, not an attack.
 */
export function isTopologyReport(v: unknown): v is TopologyReport {
  const ok =
    isObj(v) &&
    isNum(v.channel) &&
    typeof v.publisher === 'string' &&
    isNum(v.k) &&
    isNum(v.m) &&
    isNum(v.rootSlots) &&
    isNum(v.overcommitted) &&
    isNum(v.changes) &&
    isObj(v.slots) &&
    isObj(v.topology) &&
    isObj(v.topology.parents) &&
    isObj(v.topology.homes) &&
    Object.values(v.topology.homes).every((h) => Array.isArray(h) && h.every(isIndex)) &&
    isObj(v.depth) &&
    Object.values(v.depth).every((d) => isNumArray(d)) &&
    Array.isArray(v.peers) &&
    v.peers.every(
      (p) =>
        isObj(p) &&
        typeof p.id === 'string' &&
        isNum(p.failures) &&
        Array.isArray(p.avoid) &&
        p.avoid.every((a) => typeof a === 'string') &&
        (p.stats === null || isSubscriberStats(p.stats)),
    )
  if (!ok) return false
  if (v.unattached !== undefined && !isNum(v.unattached)) delete v.unattached
  for (const p of v.peers as Obj[]) if (p.link !== undefined && p.link !== null && !isPeerLink(p.link)) p.link = null
  const ps = v.publisherStats
  if (ps !== undefined) {
    const good = isObj(ps) && (ps.encoder === null || isEncoderRates(ps.encoder)) && (ps.uplink === null || isUplinkRates(ps.uplink))
    if (!good) delete v.publisherStats
  }
  return true
}
