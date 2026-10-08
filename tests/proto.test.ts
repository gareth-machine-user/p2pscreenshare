import { describe, expect, it } from 'vitest'
import { decodePieces, encodePieces } from '../src/proto/fec'
import { decodeFragment, encodeFragment, HEADER_SIZE, isLegacyAudio, MAX_PIECES, NO_REF, peekChannel, withReplayFlag, type FragmentHeader } from '../src/proto/framing'
import { packetize, type EncodedFrame } from '../src/media/packetizer'
import { Reassembler, type AssembledFrame } from '../src/media/reassembler'

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

function combinations(n: number, r: number): number[][] {
  const res: number[][] = []
  const rec = (start: number, acc: number[]) => {
    if (acc.length === r) return void res.push([...acc])
    for (let i = start; i < n; i++) rec(i + 1, [...acc, i])
  }
  rec(0, [])
  return res
}

describe('framing', () => {
  const h: FragmentHeader = {
    channel: 0xdeadbeef,
    key: true,
    audio: false,
    replay: false,
    layer: 2,
    epoch: 7,
    frameSeq: 123456,
    gopId: 123400,
    refSeq: NO_REF,
    captureTime: 1759650000123.25,
    k: 4,
    m: 1,
    pieceIdx: 3,
    stripe: 3,
    frameLen: 99999,
    fragIdx: 2,
    fragCount: 5,
  }

  it('round-trips headers and payload', () => {
    const payload = randomBytes(500)
    const f = decodeFragment(encodeFragment(h, payload))!
    expect(f.header).toEqual(h)
    expect(f.payload).toEqual(payload)
  })

  it('carries a u32 channel id in a 40-byte header (wire v3)', () => {
    const raw = encodeFragment(h, randomBytes(10))
    expect(HEADER_SIZE).toBe(40)
    expect(raw[0]).toBe(3)
    expect(peekChannel(raw)).toBe(0xdeadbeef)
    expect(peekChannel(raw.subarray(0, 20))).toBe(-1)
  })

  it('sets the replay flag without touching the original', () => {
    const raw = encodeFragment(h, randomBytes(10))
    const replayed = withReplayFlag(raw)
    expect(decodeFragment(raw)!.header.replay).toBe(false)
    expect(decodeFragment(replayed)!.header).toEqual({ ...h, replay: true })
  })

  it('rejects malformed input', () => {
    expect(decodeFragment(new Uint8Array(5))).toBeNull()
    expect(decodeFragment(encodeFragment({ ...h, fragIdx: 5 }, new Uint8Array(1)))).toBeNull()
  })

  it('refuses to encode a stripe layout the u8 header fields would truncate', () => {
    expect(() => encodeFragment({ ...h, k: 2.5 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, k: 0 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, k: 300, m: 0 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, k: MAX_PIECES, m: 1 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, m: -1 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, pieceIdx: 5, stripe: 5 }, new Uint8Array(1))).toThrow(RangeError)
    expect(() => encodeFragment({ ...h, k: MAX_PIECES - 1, m: 1, pieceIdx: 0, stripe: 0 }, new Uint8Array(1))).not.toThrow()
  })

  it('treats only whole audio frames (audio, k=1, m=0) as legacy, and lets only those travel on any stripe', () => {
    const audio = { ...h, audio: true, key: false, layer: 0, k: 1, m: 0, pieceIdx: 0, fragIdx: 0, fragCount: 1 }
    expect(isLegacyAudio(audio)).toBe(true)
    expect(isLegacyAudio({ ...audio, audio: false })).toBe(false)
    expect(isLegacyAudio({ ...audio, k: 2 })).toBe(false)
    expect(isLegacyAudio({ ...audio, m: 1 })).toBe(false)
    // Legacy audio copies go out on every stripe under one signature.
    expect(decodeFragment(encodeFragment({ ...audio, stripe: 3 }, new Uint8Array(4)))?.header.stripe).toBe(3)
    // Anything else must be on its own piece's stripe.
    expect(decodeFragment(encodeFragment({ ...audio, audio: false, stripe: 3 }, new Uint8Array(4)))).toBeNull()
    expect(decodeFragment(encodeFragment({ ...audio, m: 1, stripe: 1 }, new Uint8Array(4)))).toBeNull()
  })
})

describe('fec', () => {
  for (const [k, m] of [
    [1, 0],
    [1, 1],
    [3, 1],
    [4, 2],
    [5, 3],
  ]) {
    it(`k=${k} m=${m} recovers from any ${m} erasures`, () => {
      const frame = randomBytes(1000 + k * 37, k * 10 + m)
      const pieces = encodePieces(frame, k, m)
      expect(pieces).toHaveLength(k + m)
      for (const keep of combinations(k + m, k)) {
        const avail = pieces.map((p, i) => (keep.includes(i) ? p : undefined))
        expect(decodePieces(avail, k, m, frame.byteLength)).toEqual(frame)
      }
    })
  }

  it('refuses layouts it cannot code', () => {
    expect(() => encodePieces(randomBytes(10), 2.5, 1)).toThrow(RangeError)
    expect(() => encodePieces(randomBytes(10), 0, 1)).toThrow(RangeError)
    expect(() => encodePieces(randomBytes(10), 200, 100)).toThrow(RangeError)
  })

  it('k=16 m=8 (the largest settings) recovers from any 8 erasures', () => {
    const k = 16
    const m = 8
    const frame = randomBytes(5000, 99)
    const pieces = encodePieces(frame, k, m)
    // C(24, 16) is too many to try them all: the worst cases (every data piece but the parity
    // can cover lost) plus a deterministic sample of random ones.
    const patterns: number[][] = [
      [...Array(k + m).keys()].slice(m), // the first 8 data pieces lost
      [...Array(k + m).keys()].filter((i) => i % 3 !== 0).slice(0, k), // spread losses
    ]
    let x = 12345
    const rand = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32
    for (let n = 0; n < 300; n++) {
      const idx = [...Array(k + m).keys()]
      for (let i = idx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[idx[i], idx[j]] = [idx[j], idx[i]]
      }
      patterns.push(idx.slice(0, k))
    }
    for (const keep of patterns) {
      const avail = pieces.map((p, i) => (keep.includes(i) ? p : undefined))
      expect(decodePieces(avail, k, m, frame.byteLength), `keep ${keep}`).toEqual(frame)
    }
    expect(decodePieces(pieces.map((p, i) => (i < k - 1 ? p : undefined)), k, m, frame.byteLength)).toBeNull()
  })

  it('returns null with fewer than k pieces', () => {
    const pieces = encodePieces(randomBytes(100), 3, 1)
    expect(decodePieces([pieces[0], undefined, undefined, pieces[3]], 3, 1, 100)).toBeNull()
  })
})

describe('packetize + reassemble', () => {
  const frame = (seq: number, size: number, audio = false): EncodedFrame => ({
    epoch: 1,
    seq,
    gopId: 0,
    refSeq: seq === 0 ? NO_REF : seq - 1,
    key: seq === 0,
    layer: 0,
    audio,
    captureTime: 1000 + seq,
    data: randomBytes(size, seq + 3),
  })
  /** An audio frame as older publishers sent it: whole on every stripe, header k=1/m=0. */
  const legacyAudio = (f: EncodedFrame, stripes: number): Uint8Array[] =>
    Array.from({ length: stripes }, (_, stripe) =>
      encodeFragment(
        { channel: 9, key: f.key, audio: true, replay: false, layer: 0, epoch: f.epoch, frameSeq: f.seq, gopId: f.gopId, refSeq: f.refSeq, captureTime: f.captureTime, k: 1, m: 0, pieceIdx: 0, stripe, frameLen: f.data.byteLength, fragIdx: 0, fragCount: 1 },
        f.data,
      ),
    )

  it('reassembles from shuffled fragments with one stripe missing (k=4, m=1)', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const f = frame(0, 200_000)
    const stripes = packetize(f, 4, 1, 9)
    const frags = stripes.filter((_, s) => s !== 2).flat()
    frags.sort((a, b) => a[10] - b[10] || a.byteLength - b.byteLength) // arbitrary reorder
    for (const raw of [...frags, ...frags]) r.push(decodeFragment(raw)!, 0) // with duplicates
    expect(out).toHaveLength(1)
    expect(out[0].data).toEqual(f.data)
    expect(out[0].key).toBe(true)
  })

  it('does not emit with too many stripes missing', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const stripes = packetize(frame(1, 5000), 4, 1, 9)
    for (const raw of [...stripes[0], ...stripes[1], ...stripes[2]]) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(0)
  })

  it('erasure codes audio like video: one piece per stripe, any k of them play it', () => {
    const a = frame(5, 640, true)
    const stripes = packetize(a, 4, 2, 9)
    expect(stripes).toHaveLength(6)
    for (const [s, frags] of stripes.entries()) {
      expect(frags).toHaveLength(1)
      const h = decodeFragment(frags[0])!.header
      expect([h.audio, h.k, h.m, h.pieceIdx, h.stripe]).toEqual([true, 4, 2, s, s])
    }
    // (k+m)/k of the frame on the wire, not k+m copies.
    const payload = stripes.flat().reduce((n, raw) => n + decodeFragment(raw)!.payload.byteLength, 0)
    expect(payload).toBe(6 * 160)
    for (const keep of combinations(6, 4)) {
      const out: AssembledFrame[] = []
      const r = new Reassembler((f) => out.push(f))
      for (const s of keep) r.push(decodeFragment(stripes[s][0])!, 0)
      expect(out, `stripes ${keep}`).toHaveLength(1)
      expect(out[0].audio).toBe(true)
      expect(out[0].data).toEqual(a.data)
    }
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    for (const s of [0, 3, 5]) r.push(decodeFragment(stripes[s][0])!, 0)
    expect(out).toHaveLength(0)
  })

  it('audio pieces larger than a fragment are split and reassembled', () => {
    const a = frame(8, 50_000, true)
    const stripes = packetize(a, 2, 1, 9)
    expect(stripes[0].length).toBeGreaterThan(1)
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    for (const raw of [...stripes[2], ...stripes[0]].reverse()) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(1)
    expect(out[0].data).toEqual(a.data)
  })

  it('still plays legacy audio (older publishers: copied whole onto every stripe) once', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const a = frame(5, 300, true)
    const copies = legacyAudio(a, 4)
    for (const [s, raw] of copies.entries()) {
      const h = decodeFragment(raw)!.header
      expect([h.k, h.m, h.pieceIdx, h.stripe]).toEqual([1, 0, 0, s])
    }
    for (const raw of copies) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(1)
    expect(out[0].audio).toBe(true)
    expect(out[0].data).toEqual(a.data)
  })

  it('rejects a coded piece on the wrong stripe, video or audio', () => {
    for (const audio of [false, true]) {
      const raw = packetize(frame(9, 900, audio), 2, 1, 9)[1][0].slice()
      raw[27] = 0 // stripe byte
      expect(decodeFragment(raw), `audio=${audio}`).toBeNull()
    }
    expect(decodeFragment(legacyAudio(frame(9, 900, true), 3)[1])!.header.stripe).toBe(1)
  })
})
