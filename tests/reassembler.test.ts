import { describe, expect, it } from 'vitest'
import { packetize, type EncodedFrame } from '../src/media/packetizer'
import { Reassembler, type AssembledFrame } from '../src/media/reassembler'
import { decodeFragment, encodeFragment, MAX_FRAGMENT_PAYLOAD, MAX_FRAME_BYTES, NO_REF, type FragmentHeader } from '../src/proto/framing'

function frame(seq: number, len: number): EncodedFrame {
  const data = new Uint8Array(len)
  for (let i = 0; i < len; i++) data[i] = (i * 7 + seq) & 0xff
  return { epoch: 1, seq, gopId: 0, refSeq: NO_REF, key: true, layer: 0, audio: false, captureTime: seq, data }
}

const header: FragmentHeader = {
  channel: 1,
  key: true,
  audio: false,
  replay: false,
  layer: 0,
  epoch: 1,
  frameSeq: 1,
  gopId: 1,
  refSeq: NO_REF,
  captureTime: 0,
  k: 1,
  m: 0,
  pieceIdx: 0,
  stripe: 0,
  frameLen: 10,
  fragIdx: 0,
  fragCount: 1,
}

function frag(h: Partial<FragmentHeader>, payloadLen: number) {
  return decodeFragment(encodeFragment({ ...header, ...h }, new Uint8Array(payloadLen)))!
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

describe('Reassembler', () => {
  it('reassembles a multi-fragment frame from any k pieces', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const f = frame(5, MAX_FRAGMENT_PAYLOAD * 3 + 17)
    const stripes = packetize(f, 2, 1, 1)
    for (const raw of [...stripes[2], ...stripes[0]]) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(1)
    expect(out[0].data).toEqual(f.data)
  })

  it('drops well-formed fragments whose layout disagrees with the frame', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const len = MAX_FRAGMENT_PAYLOAD + 10
    r.push(frag({ frameLen: len, fragCount: 2 }, MAX_FRAGMENT_PAYLOAD), 0)
    // Same frame id, each fragment consistent on its own but with another frameLen / k.
    r.push(frag({ fragIdx: 1, fragCount: 2, frameLen: MAX_FRAGMENT_PAYLOAD + 20 }, 20), 0)
    r.push(frag({ frameLen: 2 * len, k: 2, fragIdx: 1, fragCount: 2 }, 10), 0)
    expect(out).toHaveLength(0)
    // The genuine last fragment still completes the frame.
    r.push(frag({ fragIdx: 1, fragCount: 2, frameLen: len }, 10), 0)
    expect(out).toHaveLength(1)
    expect(out[0].data.byteLength).toBe(len)
  })

  it('never sees misshapen fragments: decodeFragment, which relays run too, rejects them', () => {
    const len = MAX_FRAGMENT_PAYLOAD + 10
    const raw = (h: Partial<FragmentHeader>, payloadLen: number) => encodeFragment({ ...header, ...h }, new Uint8Array(payloadLen))
    // Each of these passed decodeFragment before and was only caught in the reassembler.
    expect(decodeFragment(raw({ frameLen: 0xffffffff }, 10))).toBeNull()
    expect(decodeFragment(raw({ frameLen: MAX_FRAME_BYTES + 1 }, 10))).toBeNull()
    expect(decodeFragment(raw({ fragIdx: 1, fragCount: 3, frameLen: len }, 10))).toBeNull() // wrong fragCount
    expect(decodeFragment(raw({ fragIdx: 1, fragCount: 2, frameLen: len }, 5000))).toBeNull() // oversized last chunk
    expect(decodeFragment(raw({ fragIdx: 1, fragCount: 2, frameLen: len }, 9))).toBeNull() // short last chunk
    expect(decodeFragment(raw({ fragIdx: 0, fragCount: 2, frameLen: len }, 100))).toBeNull() // short middle chunk
    expect(decodeFragment(raw({ frameLen: 10 }, 0))).toBeNull()
    // The packetizer's own output still decodes, down to the 1-byte piece of an empty frame.
    for (const [n, k, m] of [[0, 1, 0], [1, 3, 1], [len, 1, 0], [MAX_FRAGMENT_PAYLOAD * 5 + 3, 4, 2]]) {
      for (const s of packetize(frame(1, n), k, m, 1)) for (const f of s) expect(decodeFragment(f), `${n} ${k}+${m}`).not.toBeNull()
    }
    expect(decodeFragment(raw({ fragIdx: 1, fragCount: 2, frameLen: len }, 10))).not.toBeNull()
  })

  it('never throws on byte-flipped fragments', () => {
    const rand = rng(12345)
    const r = new Reassembler(() => {})
    const raws: Uint8Array[] = []
    for (let seq = 0; seq < 4; seq++) {
      for (const s of packetize(frame(seq, 100 + seq * 9000), 3, 2, 1)) raws.push(...s)
      for (const s of packetize({ ...frame(seq, 40), audio: true }, 3, 2, 1)) raws.push(...s)
    }
    let now = 0
    for (let iter = 0; iter < 5000; iter++) {
      const raw = raws[Math.floor(rand() * raws.length)].slice()
      const flips = 1 + Math.floor(rand() * 4)
      for (let i = 0; i < flips; i++) {
        // Bias towards the 40-byte header, where the interesting fields live.
        const pos = rand() < 0.8 ? Math.floor(rand() * 40) : Math.floor(rand() * raw.byteLength)
        raw[pos] ^= 1 << Math.floor(rand() * 8)
      }
      const f = decodeFragment(raw)
      now += 3
      if (f) expect(() => r.push(f, now)).not.toThrow()
    }
  })
})
