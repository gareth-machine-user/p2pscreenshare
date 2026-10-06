import { describe, expect, it } from 'vitest'
import { decodePieces, encodePieces, pieceLength } from '../src/proto/fec'

function randomBytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out[i] = x >>> 24
  }
  return out
}

/** Keeps only the pieces whose index is in `keep`. */
const only = (pieces: Uint8Array[], keep: Iterable<number>) => {
  const s = new Set(keep)
  return pieces.map((p, i) => (s.has(i) ? p : undefined))
}

/** Every subset of 0..n-1, as bitmasks. */
const subsets = (n: number) => Array.from({ length: 1 << n }, (_, mask) => [...Array(n).keys()].filter((i) => mask & (1 << i)))

describe('fec sizes', () => {
  it('handles an empty frame', () => {
    expect(pieceLength(0, 4)).toBe(1)
    const pieces = encodePieces(new Uint8Array(0), 4, 2)
    expect(pieces).toHaveLength(6)
    for (const p of pieces) expect(p).toEqual(new Uint8Array(1))
    expect(decodePieces(pieces, 4, 2, 0)).toEqual(new Uint8Array(0))
    expect(decodePieces(only(pieces, [1, 3, 4, 5]), 4, 2, 0)).toEqual(new Uint8Array(0))
  })

  it('handles frames shorter than k (some data pieces are all padding)', () => {
    const frame = randomBytes(3, 9)
    const k = 5
    const m = 2
    const pieces = encodePieces(frame, k, m)
    expect(pieces.every((p) => p.byteLength === 1)).toBe(true)
    expect(pieces[3]).toEqual(new Uint8Array(1))
    expect(pieces[4]).toEqual(new Uint8Array(1))
    // Lose two of the real bytes.
    expect(decodePieces(only(pieces, [2, 3, 4, 5, 6]), k, m, 3)).toEqual(frame)
  })

  it('handles sizes that are not a multiple of k', () => {
    for (const len of [1, 7, 8, 9, 1001, 1003]) {
      const frame = randomBytes(len, len)
      const k = 4
      const pieces = encodePieces(frame, k, 2)
      expect(pieces[0].byteLength).toBe(Math.ceil(len / k))
      expect(decodePieces(only(pieces, [0, 2, 4, 5]), k, 2, len)).toEqual(frame)
      expect(decodePieces(only(pieces, [1, 2, 3, 5]), k, 2, len)).toEqual(frame)
    }
  })
})

describe('fec erasure patterns', () => {
  for (const [k, m] of [
    [1, 0],
    [1, 1],
    [1, 3],
    [2, 1],
    [2, 2],
    [3, 1],
    [3, 3],
    [4, 2],
    [4, 4],
    [6, 3],
  ]) {
    it(`k=${k} m=${m}: decodes from every subset of at least k pieces, and no smaller one`, () => {
      const frame = randomBytes(97 + k, k * 7 + m)
      const pieces = encodePieces(frame, k, m)
      for (const keep of subsets(k + m)) {
        const out = decodePieces(only(pieces, keep), k, m, frame.byteLength)
        if (keep.length >= k) expect(out, `keep ${keep}`).toEqual(frame)
        else expect(out, `keep ${keep}`).toBeNull()
      }
    })
  }

  it('works up to the 256 stripes a fragment header can number (k=200, m=56)', () => {
    const k = 200
    const m = 56
    const frame = randomBytes(64_000, 5)
    const pieces = encodePieces(frame, k, m)
    expect(pieces).toHaveLength(256)
    // Lose m data pieces (the worst case: every parity piece is needed).
    expect(decodePieces(only(pieces, [...Array(k + m).keys()].filter((i) => i >= m)), k, m, frame.byteLength)).toEqual(frame)
    // Lose a scattered mix of data and parity.
    expect(decodePieces(only(pieces, [...Array(k + m).keys()].filter((i) => i % 5 !== 3)), k, m, frame.byteLength)).toEqual(frame)
  })

  it('works with the largest k (255) and one parity piece', () => {
    const frame = randomBytes(5000, 2)
    const pieces = encodePieces(frame, 255, 1)
    expect(decodePieces(only(pieces, [...Array(256).keys()].filter((i) => i !== 100)), 255, 1, frame.byteLength)).toEqual(frame)
  })
})

describe('fec corruption', () => {
  // Erasure coding only fills in missing pieces: it has no way to tell a damaged piece from a good
  // one. Integrity comes from the per-fragment signatures, checked before pieces reach the decoder.
  it('does not detect a corrupted data piece', () => {
    const frame = randomBytes(400, 3)
    const pieces = encodePieces(frame, 4, 2)
    pieces[1] = pieces[1].slice()
    pieces[1][0] ^= 0xff
    const out = decodePieces(pieces, 4, 2, frame.byteLength)
    expect(out).not.toBeNull()
    expect(out).not.toEqual(frame)
  })

  it('does not detect a corrupted parity piece used for reconstruction', () => {
    const frame = randomBytes(400, 4)
    const pieces = encodePieces(frame, 4, 2)
    pieces[5] = pieces[5].slice()
    pieces[5][10] ^= 0x01
    const out = decodePieces(only(pieces, [0, 2, 4, 5]), 4, 2, frame.byteLength)
    expect(out).not.toBeNull()
    expect(out).not.toEqual(frame)
    // Only the reconstructed pieces are damaged.
    expect(out!.subarray(0, 100)).toEqual(frame.subarray(0, 100))
    expect(out!.subarray(200, 300)).toEqual(frame.subarray(200, 300))
  })
})
