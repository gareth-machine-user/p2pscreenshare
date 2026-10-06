import { encodePieces } from '../proto/fec'
import { encodeFragment, MAX_FRAGMENT_PAYLOAD, type FragmentHeader } from '../proto/framing'

export interface EncodedFrame {
  epoch: number
  seq: number
  gopId: number
  refSeq: number
  key: boolean
  layer: number
  audio: boolean
  captureTime: number
  data: Uint8Array
}

/**
 * Turns an encoded frame into wire fragments, grouped by stripe.
 * Video: erasure coded into k+m pieces, piece i -> stripe i.
 * Audio: tiny, so the whole frame is sent unsplit on every stripe (first arrival wins).
 */
export function packetize(frame: EncodedFrame, k: number, m: number, channel: number): Uint8Array[][] {
  const stripes = k + m
  const base = {
    channel,
    key: frame.key,
    audio: frame.audio,
    replay: false,
    layer: frame.layer,
    epoch: frame.epoch,
    frameSeq: frame.seq,
    gopId: frame.gopId,
    refSeq: frame.refSeq,
    captureTime: frame.captureTime,
    frameLen: frame.data.byteLength,
  }
  const out: Uint8Array[][] = Array.from({ length: stripes }, () => [])

  if (frame.audio) {
    for (let s = 0; s < stripes; s++) {
      out[s].push(...fragmentPiece(frame.data, { ...base, k: 1, m: 0, pieceIdx: 0, stripe: s }))
    }
    return out
  }

  const pieces = encodePieces(frame.data, k, m)
  for (let s = 0; s < stripes; s++) {
    out[s].push(...fragmentPiece(pieces[s], { ...base, k, m, pieceIdx: s, stripe: s }))
  }
  return out
}

function fragmentPiece(
  piece: Uint8Array,
  h: Omit<FragmentHeader, 'fragIdx' | 'fragCount'>,
): Uint8Array[] {
  const fragCount = Math.max(1, Math.ceil(piece.byteLength / MAX_FRAGMENT_PAYLOAD))
  const frags: Uint8Array[] = []
  for (let i = 0; i < fragCount; i++) {
    const payload = piece.subarray(i * MAX_FRAGMENT_PAYLOAD, (i + 1) * MAX_FRAGMENT_PAYLOAD)
    frags.push(encodeFragment({ ...h, fragIdx: i, fragCount }, payload))
  }
  return frags
}
