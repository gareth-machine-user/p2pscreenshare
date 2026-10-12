// Packs messages (media fragments, probe or padding bytes) into the encoded frames of a dummy VP8
// "carrier" video track, for the RTP transport: an encoded transform swaps each frame the encoder
// produces for one of these, and the receiver's transform unpacks them.
//
// Carrier frame layout:
//
//   [prefix][len u16 LE][message] ... [len u16 LE][message][prefixLen u16 LE][version u8][magic 2]
//
// The prefix is the encoder's whole original frame (a 16×16 VP8 frame: ~70 bytes, ~180 at most),
// kept so the browser's RTP packetizer sees a valid VP8 frame, and so the receiver can give the
// decoder that very frame back (unpackCarrierFrame): Chromium frees its RTP packet buffer only as
// frames are decoded, and a frame cut down to its VP8 header doesn't decode. The carrier header is
// a trailer, so the receiver finds it without having to parse VP8 to know where the prefix ends.
//
// Padding (a headroom probe's bytes, mesh/carrierLink.ts) is a message whose first byte is
// CARRIER_PAD_TAG, which no fragment starts with (its wire version, proto/framing.ts):
// unpackCarrierFrame leaves it out.
//
// A carrier frame is lost whole (RTP has no partial delivery to the transform), and everything in
// it with it. So on a long path a carrier frame never holds pieces of two different stripes of one
// media frame (the stripe rule): one lost carrier frame then costs a media frame at most one of its
// k+m stripes, which its m parity stripes cover, instead of a retransmission a round trip later.
// Pieces of other frames, or more fragments of the same stripe, may share it. The rule has a price:
// a media frame's k stripes take k carrier frames (30 ms at 4+2 and 100 fps), every frame. On a
// short path a retransmission costs less than that, so there the rule is off (carrierStripeLimit).

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
/** First byte of a padding message (proto/framing.ts WIRE_VERSION is never 0). */
export const CARRIER_PAD_TAG = 0
/** Padding messages are at least this long (shorter leftovers aren't worth a message). */
export const CARRIER_MIN_PAD = 64
/**
 * How many queued messages past the head one pack looks at, to fill a frame past a message that
 * can't go in it (it doesn't fit, or it would break the stripe rule): one stripe can't block the
 * others, and a pack stays cheap however long the queue is.
 */
export const CARRIER_LOOKAHEAD = 64
/**
 * Round trips (ms, the lowest seen) up to which the stripe rule is off: a lost carrier frame's
 * retransmission then comes back sooner than the 30 ms (at 4+2) the rule costs every media frame.
 */
export const CARRIER_SHORT_RTT_MS = 30

/**
 * How many stripes of one media frame a carrier frame may hold on a path with this round trip
 * (ms, null when unknown): one (the stripe rule), or any number on a short path.
 */
export function carrierStripeLimit(rttMs: number | null): number {
  return rttMs !== null && rttMs >= 0 && rttMs <= CARRIER_SHORT_RTT_MS ? Infinity : 1
}

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
  /** Most stripes of one media frame a carrier frame holds (1: the stripe rule; see carrierStripeLimit). */
  stripeLimit = 1

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

  /**
   * Bytes the head message would add to a frame (its length prefix included), or 0 when nothing
   * waits. pack() always takes the head however long it is, so a caller with a byte budget packs
   * only once its budget covers this (see CarrierBudget).
   */
  get headBytes(): number {
    return this.queue.length ? CARRIER_LENGTH_SIZE + this.queue[0].data.byteLength : 0
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
    const { frame, taken } = this.packFrame(budgetBytes, prefix)
    return { frame, taken }
  }

  /**
   * As pack(), but always builds a frame, with no message if none waits. Then a padding message of
   * up to `padBytes` (and at least CARRIER_MIN_PAD) fills it towards `budgetBytes`, less what the
   * messages still waiting need: `padded` is its length (tag included). Messages often wait only
   * for the stripe rule (one stripe of a media frame per carrier frame), so padding can't wait for
   * an empty queue, but it never takes the budget they will need.
   * `hold`: a bare frame (prefix and trailer only), leaving the queue as it is.
   */
  packFrame(budgetBytes: number, prefix: Uint8Array = new Uint8Array(0), padBytes = 0, hold = false): { frame: Uint8Array; taken: number; padded: number } {
    if (prefix.byteLength > MAX_PREFIX) throw new RangeError(`carrier prefix too long: ${prefix.byteLength} bytes`)
    const scan = hold ? 0 : Math.min(this.queue.length, CARRIER_LOOKAHEAD + 1)
    const take: number[] = []
    // Media frame -> the stripes this carrier frame already holds pieces of.
    const stripes = new Map<string, number[]>()
    const limit = this.stripeLimit
    let size = prefix.byteLength + CARRIER_TRAILER_SIZE
    for (let i = 0; i < scan; i++) {
      const e = this.queue[i]
      const cost = CARRIER_LENGTH_SIZE + e.data.byteLength
      if (take.length > 0 && size + cost > budgetBytes) continue
      if (e.frame !== null && limit !== Infinity) {
        const held = stripes.get(e.frame)
        if (!held) stripes.set(e.frame, [e.stripe])
        else if (!held.includes(e.stripe)) {
          if (held.length >= limit) continue
          held.push(e.stripe)
        }
      }
      take.push(i)
      size += cost
      // Nothing more fits, not even an empty message.
      if (size + CARRIER_LENGTH_SIZE > budgetBytes) break
    }
    // Padding only in what the waiting messages won't need: it must never take their room.
    let padded = 0
    if (!hold && padBytes > 0) {
      let waiting = this.bytes
      for (const i of take) waiting -= this.queue[i].data.byteLength
      waiting += (this.queue.length - take.length) * CARRIER_LENGTH_SIZE
      const room = Math.min(budgetBytes - size - waiting - CARRIER_LENGTH_SIZE, MAX_CARRIER_MESSAGE)
      const n = Math.floor(Math.min(room, padBytes))
      if (n >= CARRIER_MIN_PAD) padded = n
    }
    if (padded) size += CARRIER_LENGTH_SIZE + padded

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
    if (padded) {
      // Zero-filled: the tag (CARRIER_PAD_TAG) and the rest.
      frame[pos] = padded & 0xff
      frame[pos + 1] = padded >>> 8
      pos += CARRIER_LENGTH_SIZE + padded
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
    return { frame, taken, padded }
  }
}

/** The carrier's send budget holds this much sending time as burst (ms): a few frames' worth. */
export const CARRIER_BURST_MS = 40

/**
 * The send rate of a carrier, as a token bucket: credit accrues at `rateKbps` (the link sets it to
 * the browser's estimate, capped), up to CARRIER_BURST_MS of it, or as much as the message waiting
 * at the head of the queue needs (`need`), so a message bigger than the burst still goes once enough
 * time has passed. Frames are only packed while the credit covers them, and what they hold is
 * spent; a bare frame (nothing fits yet) is spent too, which may leave the credit below zero.
 */
export class CarrierBudget {
  private credit = 0
  private at: number | null = null

  constructor(public rateKbps: number) {}

  /** Bytes the budget allows now. */
  get available(): number {
    return this.credit
  }

  /** Adds the credit for the time since the last refill. */
  refill(now: number, need = 0): number {
    if (this.at !== null && now > this.at) {
      const rate = Math.max(0, this.rateKbps) / 8 // bytes per ms
      const cap = Math.max(rate * CARRIER_BURST_MS, need)
      // Only up to the cap, but credit already above it (the cap shrank with `need`) is kept.
      if (this.credit < cap) this.credit = Math.min(cap, this.credit + (now - this.at) * rate)
    }
    this.at = now
    return this.credit
  }

  spend(bytes: number): void {
    this.credit -= bytes
  }
}

/**
 * The next carrier frame for the encoder's `prefix` (one per encoded frame): the queued messages
 * the budget covers, the head first and never past it; then, with nothing left waiting, up to
 * `padBytes` of padding within what remains. Spends the frame's bytes.
 */
export function nextCarrierFrame(
  packer: CarrierPacker,
  budget: CarrierBudget,
  now: number,
  prefix: Uint8Array,
  padBytes = 0,
): { frame: Uint8Array; taken: number; padded: number } {
  const overhead = prefix.byteLength + CARRIER_TRAILER_SIZE
  const head = packer.headBytes
  const avail = budget.refill(now, overhead + head)
  const hold = head > 0 && avail < overhead + head
  const r = packer.packFrame(Math.max(overhead, Math.floor(avail)), prefix, padBytes, hold)
  budget.spend(r.frame.byteLength)
  return r
}

/**
 * The messages in a carrier frame (views into `frame`, not copies). Never throws: a frame without a
 * valid trailer gives none, and a bogus or truncated length ends the list at the last whole message.
 */
export function unpackCarrier(frame: Uint8Array): Uint8Array[] {
  const prefixLen = carrierPrefixLength(frame)
  if (prefixLen === null) return []
  return walk(frame, prefixLen)
}

/** The prefix length a carrier frame's trailer gives, or null if it has no valid trailer. */
function carrierPrefixLength(frame: Uint8Array): number | null {
  const n = frame.byteLength
  if (n < CARRIER_TRAILER_SIZE) return null
  const t = n - CARRIER_TRAILER_SIZE
  if (frame[t + 4] !== MAGIC_1 || frame[t + 3] !== MAGIC_0 || frame[t + 2] !== CARRIER_VERSION) return null
  const prefixLen = frame[t] | (frame[t + 1] << 8)
  return prefixLen > t ? null : prefixLen
}

/**
 * A received carrier frame, for the receive transform: `prefix` is the encoder's original frame
 * (to hand back to the decoder), `messages` what was packed in it without padding, `padBytes` the
 * padding left out. Views into `frame`. Null if it isn't a carrier frame.
 */
export function unpackCarrierFrame(frame: Uint8Array): { prefix: Uint8Array; messages: Uint8Array[]; padBytes: number } | null {
  const prefixLen = carrierPrefixLength(frame)
  if (prefixLen === null) return null
  const messages: Uint8Array[] = []
  let padBytes = 0
  for (const m of walk(frame, prefixLen)) {
    if (m.byteLength === 0 || m[0] === CARRIER_PAD_TAG) padBytes += m.byteLength
    else messages.push(m)
  }
  return { prefix: frame.subarray(0, prefixLen), messages, padBytes }
}

function walk(frame: Uint8Array, prefixLen: number): Uint8Array[] {
  const t = frame.byteLength - CARRIER_TRAILER_SIZE
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
