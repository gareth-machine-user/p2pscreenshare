// Packs messages (media fragments, probe or padding bytes) into the encoded frames of a dummy VP8
// "carrier" video track, for the RTP transport: an encoded transform swaps each frame the encoder
// produces for one of these, and the receiver's transform unpacks them.
//
// Carrier frame layout:
//
//   [prefix][len u16 LE][message] ... [len u16 LE][message][prefixLen u16 LE][version u8][magic 2]
//
// The prefix is the encoder's own VP8 header bytes, kept so the browser's RTP packetizer and
// depacketizer see a valid VP8 frame. The carrier header is a trailer, so the receiver finds it
// without having to parse VP8 to know where the prefix ends.
//
// A carrier frame is lost whole (RTP has no partial delivery to the transform), and everything in
// it with it. So a carrier frame never holds pieces of two different stripes of one media frame:
// one lost carrier frame then costs a media frame at most one of its k+m stripes, which its m
// parity stripes cover. Pieces of other frames, or more fragments of the same stripe, may share it.

import { peekStripe } from '../proto/framing'

const MAGIC_0 = 0x50 // 'P'
const MAGIC_1 = 0x43 // 'C'
const CARRIER_VERSION = 1
/** Bytes of the carrier trailer (prefix length, version, magic). */
export const CARRIER_TRAILER_SIZE = 5
/** Bytes of each message's length prefix. */
export const CARRIER_LENGTH_SIZE = 2
/** Largest message a carrier frame can hold (its length is a u16); fragments are at most 16 KiB. */
export const MAX_CARRIER_MESSAGE = 0xffff
/** Largest prefix a trailer can describe. */
const MAX_PREFIX = 0xffff
/**
 * How many queued messages past the head one pack looks at, to fill a frame past a message that
 * can't go in it (it doesn't fit, or it would break the stripe rule): one stripe can't block the
 * others, and a pack stays cheap however long the queue is.
 */
export const CARRIER_LOOKAHEAD = 64

interface Entry {
  data: Uint8Array
  /** Frame identity and stripe if the message is a fragment; null exempts it from the stripe rule. */
  frame: string | null
  stripe: number
}

/**
 * A FIFO of messages handed over by the uplink (which already applied priorities and deadlines),
 * packed into carrier frames in order, except that a message that can't go in a frame waits for the
 * next one while later messages (within CARRIER_LOOKAHEAD) go past it.
 */
export class CarrierPacker {
  private queue: Entry[] = []
  private bytes = 0

  /** Queues a message. Throws a RangeError if it is too long for a carrier frame. */
  push(msg: Uint8Array): void {
    if (msg.byteLength > MAX_CARRIER_MESSAGE) throw new RangeError(`carrier message too long: ${msg.byteLength} bytes`)
    const ref = peekStripe(msg)
    this.queue.push({ data: msg, frame: ref?.frame ?? null, stripe: ref?.stripe ?? 0 })
    this.bytes += msg.byteLength
  }

  /** Bytes of messages waiting (without framing overhead). */
  get queuedBytes(): number {
    return this.bytes
  }

  /** Messages waiting. */
  get length(): number {
    return this.queue.length
  }

  /** Drops everything waiting. */
  clear(): void {
    this.queue = []
    this.bytes = 0
  }

  /**
   * Builds the next carrier frame of at most `budgetBytes` (everything included: prefix, length
   * prefixes and trailer), except that the first queued message always goes in, however long, so
   * the queue moves at any budget. `taken` is the bytes of messages it holds. Null if nothing is
   * queued.
   */
  pack(budgetBytes: number, prefix: Uint8Array = new Uint8Array(0)): { frame: Uint8Array; taken: number } | null {
    if (this.queue.length === 0) return null
    if (prefix.byteLength > MAX_PREFIX) throw new RangeError(`carrier prefix too long: ${prefix.byteLength} bytes`)
    const scan = Math.min(this.queue.length, CARRIER_LOOKAHEAD + 1)
    const take: number[] = []
    // Media frame -> the stripe this carrier frame already holds pieces of.
    const stripes = new Map<string, number>()
    let size = prefix.byteLength + CARRIER_TRAILER_SIZE
    for (let i = 0; i < scan; i++) {
      const e = this.queue[i]
      const cost = CARRIER_LENGTH_SIZE + e.data.byteLength
      if (take.length > 0 && size + cost > budgetBytes) continue
      if (e.frame !== null) {
        const s = stripes.get(e.frame)
        if (s !== undefined && s !== e.stripe) continue
        stripes.set(e.frame, e.stripe)
      }
      take.push(i)
      size += cost
      // Nothing more fits, not even an empty message.
      if (size + CARRIER_LENGTH_SIZE > budgetBytes) break
    }

    const frame = new Uint8Array(size)
    frame.set(prefix, 0)
    let pos = prefix.byteLength
    let taken = 0
    for (const i of take) {
      const d = this.queue[i].data
      frame[pos] = d.byteLength & 0xff
      frame[pos + 1] = d.byteLength >>> 8
      frame.set(d, pos + CARRIER_LENGTH_SIZE)
      pos += CARRIER_LENGTH_SIZE + d.byteLength
      taken += d.byteLength
    }
    frame[pos] = prefix.byteLength & 0xff
    frame[pos + 1] = prefix.byteLength >>> 8
    frame[pos + 2] = CARRIER_VERSION
    frame[pos + 3] = MAGIC_0
    frame[pos + 4] = MAGIC_1

    // Remove what was taken: only the scanned head of the queue changes.
    const kept: Entry[] = []
    let t = 0
    for (let i = 0; i < scan; i++) {
      if (t < take.length && take[t] === i) t++
      else kept.push(this.queue[i])
    }
    this.queue.splice(0, scan, ...kept)
    this.bytes -= taken
    return { frame, taken }
  }
}

/**
 * The messages in a carrier frame (views into `frame`, not copies). Never throws: a frame without a
 * valid trailer gives none, and a bogus or truncated length ends the list at the last whole message.
 */
export function unpackCarrier(frame: Uint8Array): Uint8Array[] {
  const n = frame.byteLength
  if (n < CARRIER_TRAILER_SIZE) return []
  const t = n - CARRIER_TRAILER_SIZE
  if (frame[t + 4] !== MAGIC_1 || frame[t + 3] !== MAGIC_0 || frame[t + 2] !== CARRIER_VERSION) return []
  const prefixLen = frame[t] | (frame[t + 1] << 8)
  if (prefixLen > t) return []
  const out: Uint8Array[] = []
  let pos = prefixLen
  while (pos + CARRIER_LENGTH_SIZE <= t) {
    const len = frame[pos] | (frame[pos + 1] << 8)
    const start = pos + CARRIER_LENGTH_SIZE
    if (start + len > t) break
    out.push(frame.subarray(start, start + len))
    pos = start + len
  }
  return out
}
