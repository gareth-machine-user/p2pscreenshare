import { describe, expect, it } from 'vitest'
import {
  CARRIER_BURST_MS,
  CARRIER_LENGTH_SIZE,
  CARRIER_LOOKAHEAD,
  CARRIER_MIN_PAD,
  CARRIER_PAD_TAG,
  CARRIER_TRAILER_SIZE,
  CarrierBudget,
  CarrierPacker,
  nextCarrierFrame,
  unpackCarrier,
  unpackCarrierFrame,
} from '../src/net/carrier'
import { packetize, type EncodedFrame } from '../src/media/packetizer'
import { Reassembler, type AssembledFrame } from '../src/media/reassembler'
import { decodeFragment, encodeFragment, NO_REF, peekStripe } from '../src/proto/framing'

const K = 4
const M = 2
// A keyframe-like VP8 payload header, as the encoder's frame would start.
const PREFIX = new Uint8Array([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00])

function bytes(len: number, fill: number): Uint8Array {
  return new Uint8Array(len).fill(fill & 0xff)
}

function frame(seq: number, len: number, audio = false): EncodedFrame {
  const data = new Uint8Array(len)
  for (let i = 0; i < len; i++) data[i] = (i * 13 + seq * 7) & 0xff
  return { epoch: 1, seq, gopId: 0, refSeq: NO_REF, key: seq === 0, layer: 0, audio, captureTime: seq, data }
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function drain(p: CarrierPacker, budget: number, prefix?: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (let r = p.pack(budget, prefix); r; r = p.pack(budget, prefix)) frames.push(r.frame)
  return frames
}

/** Whether a carrier frame holds at most one stripe of each media frame. */
function oneStripePerFrame(carrier: Uint8Array): boolean {
  const seen = new Map<string, number>()
  for (const msg of unpackCarrier(carrier)) {
    const ref = peekStripe(msg)
    if (!ref) continue
    const s = seen.get(ref.frame)
    if (s !== undefined && s !== ref.stripe) return false
    seen.set(ref.frame, ref.stripe)
  }
  return true
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

describe('CarrierPacker', () => {
  it('round trips messages through a frame, keeping the prefix in front', () => {
    const p = new CarrierPacker()
    const msgs = [bytes(5, 1), bytes(0, 0), bytes(300, 2), bytes(16 * 1024, 3)]
    for (const m of msgs) p.push(m)
    expect(p.queuedBytes).toBe(5 + 300 + 16 * 1024)
    const r = p.pack(1 << 20, PREFIX)!
    expect(r.taken).toBe(5 + 300 + 16 * 1024)
    expect(r.frame.subarray(0, PREFIX.byteLength)).toEqual(PREFIX)
    expect(r.frame.byteLength).toBe(PREFIX.byteLength + CARRIER_TRAILER_SIZE + r.taken + msgs.length * CARRIER_LENGTH_SIZE)
    expect(unpackCarrier(r.frame)).toEqual(msgs)
    expect(p.queuedBytes).toBe(0)
    expect(p.pack(1000)).toBeNull()
  })

  it('round trips without a prefix', () => {
    const p = new CarrierPacker()
    p.push(bytes(7, 9))
    expect(unpackCarrier(p.pack(100)!.frame)).toEqual([bytes(7, 9)])
  })

  it('keeps a frame within its budget, but always takes one message', () => {
    const p = new CarrierPacker()
    for (let i = 0; i < 10; i++) p.push(bytes(100, i))
    const overhead = PREFIX.byteLength + CARRIER_TRAILER_SIZE
    // Room for exactly three messages.
    const budget = overhead + 3 * (100 + CARRIER_LENGTH_SIZE)
    const r = p.pack(budget, PREFIX)!
    expect(r.frame.byteLength).toBe(budget)
    expect(r.taken).toBe(300)
    expect(unpackCarrier(r.frame).map((m) => m[0])).toEqual([0, 1, 2])
    // One byte less: two.
    expect(unpackCarrier(p.pack(budget - 1, PREFIX)!.frame).map((m) => m[0])).toEqual([3, 4])

    const big = new CarrierPacker()
    big.push(bytes(16 * 1024, 7))
    big.push(bytes(10, 8))
    const r2 = big.pack(1000, PREFIX)!
    expect(unpackCarrier(r2.frame)).toEqual([bytes(16 * 1024, 7)])
    expect(r2.taken).toBe(16 * 1024)
    expect(unpackCarrier(big.pack(1000)!.frame)).toEqual([bytes(10, 8)])
  })

  it('fills a frame past a message that does not fit, which keeps its place', () => {
    const p = new CarrierPacker()
    p.push(bytes(50, 1))
    p.push(bytes(500, 2))
    p.push(bytes(50, 3))
    const r = p.pack(CARRIER_TRAILER_SIZE + 2 * (50 + CARRIER_LENGTH_SIZE))!
    expect(unpackCarrier(r.frame).map((m) => m[0])).toEqual([1, 3])
    expect(unpackCarrier(p.pack(10_000)!.frame).map((m) => m[0])).toEqual([2])
  })

  it('preserves order', () => {
    const p = new CarrierPacker()
    const rand = rng(3)
    const sizes = Array.from({ length: 500 }, () => Math.floor(rand() * 3000))
    sizes.forEach((n, i) => {
      const m = bytes(n + 2, 0)
      m[0] = i & 0xff
      m[1] = i >> 8
      p.push(m)
    })
    const out: number[] = []
    for (const f of drain(p, 4000)) for (const m of unpackCarrier(f)) out.push(m[0] | (m[1] << 8))
    // Messages that fit go in order; a skipped one only ever moves later, never ahead.
    expect(out.length).toBe(500)
    expect(new Set(out).size).toBe(500)
    const p2 = new CarrierPacker()
    for (let i = 0; i < 200; i++) p2.push(bytes(100, i))
    const out2 = drain(p2, 1000).flatMap((f) => unpackCarrier(f).map((m) => m[0]))
    expect(out2).toEqual(Array.from({ length: 200 }, (_, i) => i & 0xff))
  })

  it('never puts two stripes of one media frame in a carrier frame', () => {
    const stripes = packetize(frame(1, 4000), K, M, 7)
    const p = new CarrierPacker()
    for (const s of stripes) for (const f of s) p.push(f)
    const frames = drain(p, 1 << 20)
    // Everything would fit in one frame: the rule alone splits it, one stripe per carrier frame.
    expect(frames.length).toBe(K + M)
    frames.forEach((f, i) => {
      const msgs = unpackCarrier(f)
      expect(msgs).toEqual(stripes[i])
    })
  })

  it('packs fragments of one stripe piece together, and other frames alongside', () => {
    // A 200 KB frame: 50 KB pieces, 4 fragments each.
    const a = packetize(frame(1, 200_000), K, M, 7)
    const b = packetize(frame(2, 400), K, M, 7)
    const audio = packetize(frame(1, 300, true), K, M, 7)
    expect(a[0].length).toBe(4)
    const p = new CarrierPacker()
    // Stripe-major, as a relay forwarding stripe 0 then stripe 1 would queue them.
    for (let s = 0; s < K + M; s++) for (const f of [...a[s], ...b[s], ...audio[s]]) p.push(f)
    const frames = drain(p, 1 << 20)
    for (const f of frames) expect(oneStripePerFrame(f)).toBe(true)
    expect(frames.length).toBe(K + M)
    // Same seq on audio is another media frame: it rides with the video.
    expect(unpackCarrier(frames[0]).length).toBe(a[0].length + 2)
  })

  it('looks past a blocked stripe, but only so far', () => {
    const p = new CarrierPacker()
    const f1 = packetize(frame(1, 4000), K, M, 7)
    p.push(f1[0][0])
    p.push(f1[1][0]) // blocked: stripe 1 of a frame whose stripe 0 is in this carrier frame
    for (let i = 0; i < CARRIER_LOOKAHEAD + 10; i++) p.push(bytes(10, i))
    const first = unpackCarrier(p.pack(1 << 20)!.frame)
    // The head, then the lookahead's worth (the blocked one counted), the rest wait.
    expect(first.length).toBe(1 + CARRIER_LOOKAHEAD - 1)
    expect(first[0]).toEqual(f1[0][0])
    const second = unpackCarrier(p.pack(1 << 20)!.frame)
    expect(second[0]).toEqual(f1[1][0])
    expect(second.length).toBe(1 + 11)
  })

  it('exempts non-fragments from the stripe rule', () => {
    const p = new CarrierPacker()
    // Fragment-sized, but no fragment's version byte: the "stripe" byte varies, yet they share a frame.
    for (let i = 0; i < 20; i++) {
      const m = bytes(200, 0)
      m[27] = i
      p.push(m)
    }
    p.push(bytes(3, 3)) // too short to be a fragment
    expect(peekStripe(bytes(3, 3))).toBeNull()
    expect(drain(p, 1 << 20).length).toBe(1)
  })

  it('rejects messages too long for a u16 length', () => {
    expect(() => new CarrierPacker().push(new Uint8Array(70_000))).toThrow(RangeError)
  })
})

describe('unpackCarrier', () => {
  function packed(): Uint8Array {
    const p = new CarrierPacker()
    p.push(bytes(10, 1))
    p.push(bytes(20, 2))
    p.push(bytes(30, 3))
    return p.pack(1000, PREFIX)!.frame
  }

  it('returns nothing for frames that are not carrier frames', () => {
    expect(unpackCarrier(new Uint8Array(0))).toEqual([])
    expect(unpackCarrier(new Uint8Array(4))).toEqual([])
    expect(unpackCarrier(PREFIX)).toEqual([])
    const bad = packed()
    bad[bad.byteLength - 1] ^= 0xff
    expect(unpackCarrier(bad)).toEqual([])
    const ver = packed()
    ver[ver.byteLength - 3] = 99
    expect(unpackCarrier(ver)).toEqual([])
    // A prefix length past the end.
    const pre = packed()
    pre[pre.byteLength - 5] = 0xff
    pre[pre.byteLength - 4] = 0xff
    expect(unpackCarrier(pre)).toEqual([])
  })

  it('returns the whole messages of a truncated or corrupt frame', () => {
    const f = packed()
    const trailer = f.subarray(f.byteLength - CARRIER_TRAILER_SIZE)
    // Cut inside the third message, trailer re-attached (the only way the magic survives).
    const cut = new Uint8Array(PREFIX.byteLength + 2 + 10 + 2 + 20 + 2 + 5 + CARRIER_TRAILER_SIZE)
    cut.set(f.subarray(0, cut.byteLength - CARRIER_TRAILER_SIZE))
    cut.set(trailer, cut.byteLength - CARRIER_TRAILER_SIZE)
    expect(unpackCarrier(cut)).toEqual([bytes(10, 1), bytes(20, 2)])
    // A bogus length in the second message.
    const bogus = packed()
    bogus[PREFIX.byteLength + 2 + 10] = 0xff
    bogus[PREFIX.byteLength + 2 + 10 + 1] = 0xff
    expect(unpackCarrier(bogus)).toEqual([bytes(10, 1)])
    // A dangling length byte before the trailer.
    const dangling = new Uint8Array(PREFIX.byteLength + 1 + CARRIER_TRAILER_SIZE)
    dangling.set(PREFIX)
    dangling.set(trailer, dangling.byteLength - CARRIER_TRAILER_SIZE)
    expect(unpackCarrier(dangling)).toEqual([])
  })

  it('never throws on random bytes', () => {
    const rand = rng(11)
    for (let i = 0; i < 2000; i++) {
      const f = new Uint8Array(Math.floor(rand() * 64))
      for (let j = 0; j < f.byteLength; j++) f[j] = rand() * 256
      // Half of them with a valid trailer, so the length walk is exercised.
      if (i % 2 && f.byteLength >= CARRIER_TRAILER_SIZE) f.set([rand() * 64, 0, 1, 0x50, 0x43], f.byteLength - 5)
      const msgs = unpackCarrier(f)
      for (const m of msgs) expect(m.byteLength).toBeLessThanOrEqual(f.byteLength)
    }
  })
})

describe('carrier frame loss', () => {
  // 8 Mbps at 100 carrier frames per second.
  const BUDGET = 8_000_000 / 8 / 100

  function run(lossRate: number, seed: number) {
    const rand = rng(seed)
    const frames: EncodedFrame[] = []
    const fragments = new Map<string, Uint8Array[][]>()
    // Per-stripe queues, as a relay gets them from its parents; drained round-robin into the packer.
    const stripeQueues: Uint8Array[][] = Array.from({ length: K + M }, () => [])
    const p = new CarrierPacker()
    const carriers: Uint8Array[] = []
    for (let seq = 0; seq < 400; seq++) {
      // Mostly small deltas, now and then a large frame (several fragments per piece).
      const len = rand() < 0.05 ? 50_000 + Math.floor(rand() * 150_000) : 200 + Math.floor(rand() * 20_000)
      const f = frame(seq, len, seq % 5 === 4)
      frames.push(f)
      const stripes = packetize(f, K, M, 42)
      fragments.set(`${f.audio ? 'a' : 'v'}${seq}`, stripes)
      stripes.forEach((s, i) => stripeQueues[i].push(...s))
      // Stripes arrive unevenly: each tick moves a random number from each.
      for (let moved = true; moved; ) {
        moved = false
        for (const q of stripeQueues) {
          const n = Math.floor(rand() * 3)
          for (let i = 0; i < n && q.length; i++) {
            p.push(q.shift()!)
            moved = true
          }
        }
        if (rand() < 0.5) break
      }
      // A few carrier frames per media frame, as the encoder ticks.
      for (let i = 0; i < 3; i++) {
        const r = p.pack(BUDGET, PREFIX)
        if (r) carriers.push(r.frame)
      }
    }
    for (const q of stripeQueues) for (const f of q) p.push(f)
    carriers.push(...drain(p, BUDGET, PREFIX))

    const out = new Map<string, AssembledFrame>()
    const r = new Reassembler((f) => out.set(`${f.audio ? 'a' : 'v'}${f.seq}`, f))
    // Stripes each media frame lost (any of the stripe's fragments in a lost carrier frame).
    const lost = new Map<string, Set<number>>()
    let lostCarriers = 0
    let mixed = 0
    for (const c of carriers) {
      if (!oneStripePerFrame(c)) mixed++
      const msgs = unpackCarrier(c)
      if (rand() < lossRate) {
        lostCarriers++
        for (const m of msgs) {
          const h = decodeFragment(m)!.header
          const id = `${h.audio ? 'a' : 'v'}${h.frameSeq}`
          if (!lost.has(id)) lost.set(id, new Set())
          lost.get(id)!.add(h.stripe)
        }
        continue
      }
      for (const m of msgs) r.push(decodeFragment(m)!, 0)
    }

    expect(mixed).toBe(0)
    let recoverable = 0
    let hit = 0
    let bad = 0
    for (const f of frames) {
      const id = `${f.audio ? 'a' : 'v'}${f.seq}`
      const n = lost.get(id)?.size ?? 0
      if (n > 0) hit++
      if (n > M) continue
      recoverable++
      if (!sameBytes(out.get(id)?.data, f.data)) bad++
    }
    expect(bad).toBe(0)
    return { carriers: carriers.length, lostCarriers, hit, recoverable }
  }

  it('loses no media frame to 0.5% carrier loss that parity can cover', () => {
    const s = run(0.005, 1)
    expect(s.lostCarriers).toBeGreaterThan(0)
    expect(s.hit).toBeGreaterThan(0)
    expect(s.recoverable).toBe(400)
  })

  it('loses no media frame to 5% carrier loss that parity can cover', () => {
    const s = run(0.05, 2)
    expect(s.lostCarriers).toBeGreaterThan(20)
    expect(s.hit).toBeGreaterThan(20)
    // One lost carrier frame takes at most one stripe: frames beyond parity need 3 losses.
    expect(s.recoverable).toBeGreaterThan(390)
  })
})

describe('padding and the receive side', () => {
  it('reports the head message’s cost', () => {
    const p = new CarrierPacker()
    expect(p.headBytes).toBe(0)
    p.push(bytes(300, 1))
    p.push(bytes(10, 2))
    expect(p.headBytes).toBe(300 + CARRIER_LENGTH_SIZE)
    p.pack(1000)
    expect(p.headBytes).toBe(0)
  })

  it('gives back the original frame and the messages, leaving padding out', () => {
    const p = new CarrierPacker()
    p.push(bytes(100, 1))
    p.push(bytes(50, 2))
    const r = p.packFrame(2000, PREFIX, 10_000)
    expect(r.taken).toBe(150)
    // Padding fills the frame up to the budget.
    expect(r.padded).toBe(2000 - (PREFIX.byteLength + CARRIER_TRAILER_SIZE + 3 * CARRIER_LENGTH_SIZE + 150))
    expect(r.frame.byteLength).toBe(2000)
    const u = unpackCarrierFrame(r.frame)!
    expect(u.prefix).toEqual(PREFIX)
    expect(u.messages).toEqual([bytes(100, 1), bytes(50, 2)])
    expect(u.padBytes).toBe(r.padded)
    // The plain unpack sees the padding as a message starting with the tag.
    expect(unpackCarrier(r.frame).at(-1)![0]).toBe(CARRIER_PAD_TAG)
    expect(unpackCarrierFrame(PREFIX)).toBeNull()
  })

  it('pads only behind the last waiting message, at most what was asked, never less than the minimum', () => {
    const p = new CarrierPacker()
    p.push(bytes(100, 1))
    p.push(bytes(5000, 2))
    // The second message doesn't fit: no padding takes its room.
    expect(p.packFrame(1000, PREFIX, 10_000).padded).toBe(0)
    p.clear()
    expect(p.packFrame(1000, PREFIX, 300).padded).toBe(300)
    expect(p.packFrame(1000, PREFIX, CARRIER_MIN_PAD - 1).padded).toBe(0)
    // Too little room left.
    expect(p.packFrame(PREFIX.byteLength + CARRIER_TRAILER_SIZE + CARRIER_LENGTH_SIZE + CARRIER_MIN_PAD - 1, PREFIX, 1000).padded).toBe(0)
    // A bare frame still carries the prefix and the trailer.
    const bare = p.packFrame(0, PREFIX)
    expect(bare.frame.byteLength).toBe(PREFIX.byteLength + CARRIER_TRAILER_SIZE)
    expect(unpackCarrierFrame(bare.frame)).toEqual({ prefix: PREFIX, messages: [], padBytes: 0 })
  })

  it('holds the queue for a bare frame', () => {
    const p = new CarrierPacker()
    p.push(bytes(10, 1))
    const r = p.packFrame(1 << 20, PREFIX, 1000, true)
    expect(r.taken).toBe(0)
    expect(r.padded).toBe(0)
    expect(p.length).toBe(1)
  })

  it('never takes a fragment for padding', () => {
    const frag = encodeFragment(
      { channel: 1, key: true, audio: false, replay: false, layer: 0, epoch: 1, frameSeq: 0, gopId: 0, refSeq: NO_REF, captureTime: 0, k: 1, m: 0, pieceIdx: 0, stripe: 0, frameLen: 10, fragIdx: 0, fragCount: 1 },
      new Uint8Array(10),
    )
    expect(frag[0]).not.toBe(CARRIER_PAD_TAG)
    const p = new CarrierPacker()
    p.push(frag)
    expect(unpackCarrierFrame(p.packFrame(1000, PREFIX, 500).frame)!.messages).toEqual([frag])
  })
})

describe('CarrierBudget', () => {
  const FRAME_MS = 10
  const overhead = PREFIX.byteLength + CARRIER_TRAILER_SIZE

  /** Sends `ms` of 100 fps carrier frames at `kbps` from a backlog of `size`-byte messages. */
  function run(kbps: number, size: number, ms: number, pad = 0) {
    const p = new CarrierPacker()
    // A backlog that outlasts the run.
    const n = Math.ceil(((kbps / 8) * ms * 1.2) / size) + 10
    for (let i = 0; i < n; i++) p.push(bytes(size, i))
    const b = new CarrierBudget(kbps)
    let bytes_ = 0
    let taken = 0
    let padded = 0
    let biggest = 0
    for (let t = 0; t <= ms; t += FRAME_MS) {
      const r = nextCarrierFrame(p, b, t, PREFIX, pad)
      bytes_ += r.frame.byteLength
      taken += r.taken
      padded += r.padded
      biggest = Math.max(biggest, r.frame.byteLength)
    }
    return { kbps: (bytes_ * 8) / ms, taken, padded, biggest }
  }

  it('sends at its rate, whatever the message size', () => {
    // (At most CARRIER_LOOKAHEAD + 1 messages go in a frame: 100 fps of them carry 8 Mbps from ~150 B up.)
    for (const size of [200, 1200, 16 * 1024]) {
      const r = run(8000, size, 10_000)
      expect(r.kbps).toBeGreaterThan(8000 * 0.95)
      expect(r.kbps).toBeLessThan(8000 * 1.05)
    }
    // 16 KiB fragments at 300 kbps: one every ~440 ms, not one a frame.
    const slow = run(300, 16 * 1024, 10_000)
    expect(slow.kbps).toBeLessThan(300 * 1.1)
    expect(slow.taken / (16 * 1024)).toBeGreaterThanOrEqual(21)
  })

  it('bursts at most CARRIER_BURST_MS worth, or one head message', () => {
    const b = new CarrierBudget(8000)
    b.refill(0)
    // A long pause: the credit is capped.
    expect(b.refill(10_000)).toBe((8000 / 8) * CARRIER_BURST_MS)
    expect(b.refill(20_000, 50_000)).toBe(50_000)
    const r = run(8000, 1200, 2000)
    expect(r.biggest).toBeLessThanOrEqual((8000 / 8) * CARRIER_BURST_MS + overhead + 1200)
  })

  it('pads up to its rate when no media waits, and nothing beyond', () => {
    const p = new CarrierPacker()
    const b = new CarrierBudget(4000)
    let sent = 0
    let pad = 0
    for (let t = 0; t <= 5000; t += FRAME_MS) {
      const r = nextCarrierFrame(p, b, t, PREFIX, 1 << 30)
      sent += r.frame.byteLength
      pad += r.padded
    }
    expect((sent * 8) / 5000).toBeGreaterThan(4000 * 0.95)
    expect((sent * 8) / 5000).toBeLessThan(4000 * 1.05)
    expect(pad).toBeGreaterThan(0)
    // Media first: with a backlog, no padding at all.
    expect(run(4000, 1200, 5000, 1 << 30).padded).toBe(0)
  })

  it('sends bare frames (prefix and trailer) when there is nothing to send, or no credit', () => {
    const p = new CarrierPacker()
    const b = new CarrierBudget(0)
    p.push(bytes(100, 1))
    for (let t = 0; t < 100; t += FRAME_MS) expect(nextCarrierFrame(p, b, t, PREFIX).frame.byteLength).toBe(overhead)
    expect(p.length).toBe(1)
  })
})
