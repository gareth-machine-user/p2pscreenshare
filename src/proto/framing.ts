// Binary wire format for media fragments. One data-channel message == one fragment.
//
// A frame is erasure-coded into k data + m parity pieces; stripe i carries piece i of every frame.
// Pieces larger than MAX_FRAGMENT_PAYLOAD are split into fragments.
//
// Every fragment ends with the host's Ed25519 signature (see signedRegion), so relays can drop
// anything the host didn't produce before forwarding it.

export const WIRE_VERSION = 2
export const HEADER_SIZE = 36
export const SIG_SIZE = 64
// Keep messages comfortably under the 16KiB cross-browser SCTP message limit.
export const MAX_FRAGMENT_PAYLOAD = 16 * 1024 - HEADER_SIZE - SIG_SIZE
export const NO_REF = 0xffffffff

const FLAG_KEY = 1 << 0
const FLAG_AUDIO = 1 << 1
const FLAG_REPLAY = 1 << 2
const LAYER_SHIFT = 3
const LAYER_MASK = 0b11 << LAYER_SHIFT

export interface FragmentHeader {
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
  buf.set(payload, HEADER_SIZE)
  return buf // signature left zeroed: see signedRegion
}

export function decodeFragment(raw: Uint8Array): Fragment | null {
  if (raw.byteLength < HEADER_SIZE + SIG_SIZE) return null
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  if (v.getUint8(0) !== WIRE_VERSION) return null
  const flags = v.getUint8(1)
  const header: FragmentHeader = {
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
  if (header.fragCount === 0 || header.fragIdx >= header.fragCount) return null
  if (header.k === 0 || header.pieceIdx >= header.k + header.m) return null
  // Video piece i only travels on stripe i (the stripe byte isn't signed, see signedRegion).
  if (!header.audio && header.stripe !== header.pieceIdx) return null
  return { header, payload: raw.subarray(HEADER_SIZE, raw.byteLength - SIG_SIZE), raw }
}

/** Returns a copy of `raw` with the replay flag set (used when serving from a GOP cache). */
export function withReplayFlag(raw: Uint8Array): Uint8Array {
  const copy = raw.slice()
  copy[1] |= FLAG_REPLAY
  return copy
}

/**
 * The bytes the host signs: header and payload, with the two bytes relays may legitimately vary
 * zeroed — the replay flag (set when serving from a GOP cache) and the stripe (audio frames go out
 * identically on every stripe, so one signature covers every copy).
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
export function peekStripe(raw: Uint8Array): number {
  return raw[27]
}
export function peekLayer(raw: Uint8Array): number {
  return (raw[1] & LAYER_MASK) >> LAYER_SHIFT
}
export function peekIsKey(raw: Uint8Array): boolean {
  return (raw[1] & FLAG_KEY) !== 0
}
