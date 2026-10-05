import { describe, expect, it } from 'vitest'
import { decodePieces, encodePieces } from '../src/proto/fec'
import { decodeFragment, encodeFragment, NO_REF, withReplayFlag, type FragmentHeader } from '../src/proto/framing'
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

  it('reassembles from shuffled fragments with one stripe missing (k=4, m=1)', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const f = frame(0, 200_000)
    const stripes = packetize(f, 4, 1)
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
    const stripes = packetize(frame(1, 5000), 4, 1)
    for (const raw of [...stripes[0], ...stripes[1], ...stripes[2]]) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(0)
  })

  it('audio is duplicated on every stripe and emitted once', () => {
    const out: AssembledFrame[] = []
    const r = new Reassembler((f) => out.push(f))
    const a = frame(5, 300, true)
    const stripes = packetize(a, 3, 1)
    expect(stripes.every((s) => s.length === 1)).toBe(true)
    for (const raw of stripes.flat()) r.push(decodeFragment(raw)!, 0)
    expect(out).toHaveLength(1)
    expect(out[0].audio).toBe(true)
    expect(out[0].data).toEqual(a.data)
  })
})
