// Binary wire format for media fragments. One data-channel message == one fragment.
//
// A frame is erasure-coded into k data + m parity pieces; stripe i carries piece i of every frame.
// Pieces larger than MAX_FRAGMENT_PAYLOAD are split into fragments.
//
// A channel is one encoding of one publisher's stream; its id is part of every fragment. Every
// fragment ends with the publisher's Ed25519 signature (see signedRegion), which covers the
// channel id, so relays can drop anything the channel's publisher didn't produce before forwarding.

const WIRE_VERSION = 3
export const HEADER_SIZE = 40
const SIG_SIZE = 64
// Keep messages comfortably under the 16KiB cross-browser SCTP message limit.
export const MAX_FRAGMENT_PAYLOAD = 16 * 1024 - HEADER_SIZE - SIG_SIZE
export const NO_REF = 0xffffffff
/**
 * Most pieces (k + m) a frame may have: the header numbers pieces in a byte, and fec.ts's Cauchy
 * rows need k + m <= 256 (GF(256)).
 */
export const MAX_PIECES = 256
/** Largest frame accepted (bytes); bounds what a bogus header can make a receiver allocate. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Bytes per erasure-coded piece of a frameLen-byte frame split k ways (at least 1). */
export function pieceLength(frameLen: number, k: number): number {
  return Math.max(1, Math.ceil(frameLen / k))
}

/** Throws unless k data and m parity pieces form a codable layout (integers, k >= 1, m >= 0, k + m <= MAX_PIECES). */
export function assertStripes(k: number, m: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(m) || k < 1 || m < 0 || k + m > MAX_PIECES) {
    throw new RangeError(`bad stripe layout k=${k} m=${m} (need integers, k >= 1, m >= 0, k + m <= ${MAX_PIECES})`)
  }
}

const FLAG_KEY = 1 << 0
const FLAG_AUDIO = 1 << 1
// Left out of the signature (see signedRegion) because relays set it on bytes the publisher already
// signed, when replaying from their GOP cache. So any relay can set or clear it: that only moves a
// frame in or out of latency stats and lets a seen frame reassemble again during a requested repair
// (Reassembler.expectReplay); relayNode refuses "replays" more than a GOP old. It can't change
// what is decoded.
const FLAG_REPLAY = 1 << 2
const LAYER_SHIFT = 3
const LAYER_MASK = 0b11 << LAYER_SHIFT

export interface FragmentHeader {
  /** Random u32 drawn when the channel starts. */
  channel: number
  key: boolean
  audio: boolean
  /** Set by relays when re-sending from their GOP cache (excluded from latency stats). */
  replay: boolean
  /** Temporal layer id (0 = base layer). */
  layer: number
  epoch: number
  frameSeq: number
  /** frameSeq of the keyframe that starts this frame's GOP. */
  gopId: number
  /** frameSeq of the frame this one references, or NO_REF for keyframes/audio. */
  refSeq: number
  /** Host wall-clock time (ms) at capture. */
  captureTime: number
  k: number
  m: number
  pieceIdx: number
  stripe: number
  frameLen: number
  fragIdx: number
  fragCount: number
}

export interface Fragment {
  header: FragmentHeader
  payload: Uint8Array
  /** The full encoded message (header + payload + signature), forwarded verbatim by relays. */
  raw: Uint8Array
}

export function encodeFragment(h: FragmentHeader, payload: Uint8Array): Uint8Array {
  // The header fields are u8: a bad layout would be silently truncated on the wire.
  assertStripes(h.k, h.m)
  if (!Number.isInteger(h.pieceIdx) || h.pieceIdx < 0 || h.pieceIdx >= h.k + h.m) throw new RangeError(`bad piece index ${h.pieceIdx}`)
  const buf = new Uint8Array(HEADER_SIZE + payload.byteLength + SIG_SIZE)
  const v = new DataView(buf.buffer)
  v.setUint8(0, WIRE_VERSION)
  let flags = (h.layer << LAYER_SHIFT) & LAYER_MASK
  if (h.key) flags |= FLAG_KEY
  if (h.audio) flags |= FLAG_AUDIO
  if (h.replay) flags |= FLAG_REPLAY
  v.setUint8(1, flags)
  v.setUint16(2, h.epoch, true)
  v.setUint32(4, h.frameSeq, true)
  v.setUint32(8, h.gopId, true)
  v.setUint32(12, h.refSeq, true)
  v.setFloat64(16, h.captureTime, true)
  v.setUint8(24, h.k)
  v.setUint8(25, h.m)
  v.setUint8(26, h.pieceIdx)
  v.setUint8(27, h.stripe)
  v.setUint32(28, h.frameLen, true)
  v.setUint16(32, h.fragIdx, true)
  v.setUint16(34, h.fragCount, true)
  v.setUint32(36, h.channel >>> 0, true)
  buf.set(payload, HEADER_SIZE)
  return buf // signature left zeroed: see signedRegion
}

export function decodeFragment(raw: Uint8Array): Fragment | null {
  if (raw.byteLength < HEADER_SIZE + SIG_SIZE) return null
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (v.getUint8(0) !== WIRE_VERSION) return null
  const flags = v.getUint8(1)
  const header: FragmentHeader = {
    channel: v.getUint32(36, true),
    key: (flags & FLAG_KEY) !== 0,
    audio: (flags & FLAG_AUDIO) !== 0,
    replay: (flags & FLAG_REPLAY) !== 0,
    layer: (flags & LAYER_MASK) >> LAYER_SHIFT,
    epoch: v.getUint16(2, true),
    frameSeq: v.getUint32(4, true),
    gopId: v.getUint32(8, true),
    refSeq: v.getUint32(12, true),
    captureTime: v.getFloat64(16, true),
    k: v.getUint8(24),
    m: v.getUint8(25),
    pieceIdx: v.getUint8(26),
    stripe: v.getUint8(27),
    frameLen: v.getUint32(28, true),
    fragIdx: v.getUint16(32, true),
    fragCount: v.getUint16(34, true),
  }
  const payload = raw.subarray(HEADER_SIZE, raw.byteLength - SIG_SIZE)
  return wellFormed(header, payload.byteLength) ? { header, payload, raw } : null
}

/**
 * Checks a header is self-consistent with how the packetizer splits frames, so a corrupt or
 * hostile one (signed or not) can't make a receiver allocate huge buffers or write out of bounds,
 * and relays don't forward fragments no receiver would accept.
 */
function wellFormed(h: FragmentHeader, payloadLen: number): boolean {
  if (h.k === 0 || h.pieceIdx >= h.k + h.m || h.frameLen > MAX_FRAME_BYTES) return false
  // Piece i only travels on stripe i (the stripe byte isn't signed, see signedRegion). Older
  // publishers sent each audio frame whole (k=1, m=0) on every stripe: still accepted from them.
  if (h.stripe !== h.pieceIdx && !isLegacyAudio(h)) return false
  const P = pieceLength(h.frameLen, h.k)
  const fragCount = Math.max(1, Math.ceil(P / MAX_FRAGMENT_PAYLOAD))
  if (h.fragCount !== fragCount || h.fragIdx >= fragCount) return false
  // Every fragment but the last is full; the last carries exactly the rest of the piece.
  return payloadLen === Math.min(MAX_FRAGMENT_PAYLOAD, P - h.fragIdx * MAX_FRAGMENT_PAYLOAD)
}

/** An audio frame sent whole on every stripe, the format before audio was erasure coded. */
export function isLegacyAudio(h: FragmentHeader): boolean {
  return h.audio && h.k === 1 && h.m === 0
}

/** Returns a copy of `raw` with the replay flag set (used when serving from a GOP cache). */
export function withReplayFlag(raw: Uint8Array): Uint8Array {
  const copy = raw.slice()
  copy[1] |= FLAG_REPLAY
  return copy
}

/**
 * The bytes the publisher signs: header and payload, with the two bytes relays may legitimately vary
 * zeroed — the replay flag (set when serving from a GOP cache) and the stripe (older publishers sent
 * audio identically on every stripe under one signature; decodeFragment holds every other piece i
 * to stripe i).
 */
export function signedRegion(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const msg = raw.slice(0, raw.byteLength - SIG_SIZE)
  msg[1] &= ~FLAG_REPLAY
  msg[27] = 0
  return msg
}

export function signatureOf(raw: Uint8Array): Uint8Array {
  return raw.subarray(raw.byteLength - SIG_SIZE)
}

/** Fast header peeks for the relay hot path (no full decode). */
export function peekChannel(raw: Uint8Array): number {
  return raw.byteLength < HEADER_SIZE ? -1 : new DataView(raw.buffer, raw.byteOffset + 36, 4).getUint32(0, true)
}
export function peekLayer(raw: Uint8Array): number {
  return (raw[1] & LAYER_MASK) >> LAYER_SHIFT
}
export function peekIsKey(raw: Uint8Array): boolean {
  return (raw[1] & FLAG_KEY) !== 0
}
