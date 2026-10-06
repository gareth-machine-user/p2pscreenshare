import { decodePieces, pieceLength } from '../proto/fec'
import { MAX_FRAGMENT_PAYLOAD, type Fragment } from '../proto/framing'
import type { EncodedFrame } from './packetizer'

export interface AssembledFrame extends EncodedFrame {
  /** True if any contributing fragment was replayed from a relay's GOP cache. */
  replay: boolean
  /** Local time (ms) the frame became decodable. */
  completedAt: number
}

interface PieceState {
  chunks: (Uint8Array | undefined)[]
  received: number
}

interface FrameState {
  k: number
  m: number
  frameLen: number
  pieces: (Uint8Array | undefined)[]
  partial: Map<number, PieceState>
  completePieces: number
  replay: boolean
  done: boolean
  firstSeenAt: number
  header: Fragment['header']
}

const RETAIN_MS = 6000
/** Largest frame accepted (bytes); bounds what a bogus header can make us allocate. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * Checks a fragment's header is self-consistent with how the packetizer splits frames, so a
 * corrupt or hostile header can't make us allocate huge buffers or write out of bounds.
 */
function wellFormed(frag: Fragment): boolean {
  const h = frag.header
  if (h.k === 0 || h.frameLen > MAX_FRAME_BYTES || h.pieceIdx >= h.k + h.m) return false
  const P = pieceLength(h.frameLen, h.k)
  const fragCount = Math.max(1, Math.ceil(P / MAX_FRAGMENT_PAYLOAD))
  if (h.fragCount !== fragCount || h.fragIdx >= fragCount) return false
  const len = frag.payload.byteLength
  if (h.fragIdx * MAX_FRAGMENT_PAYLOAD + len > P) return false
  return h.fragIdx === fragCount - 1 || len === MAX_FRAGMENT_PAYLOAD
}

/**
 * Collects fragments (from any stripe, any order, with duplicates) and emits each frame once,
 * as soon as any k of its k+m pieces are complete.
 */
export class Reassembler {
  private frames = new Map<string, FrameState>()
  private lastPrune = 0
  /** Video frames that were dropped without ever getting k complete pieces. */
  incomplete = 0

  constructor(private onFrame: (frame: AssembledFrame) => void) {}

  push(frag: Fragment, now: number): void {
    if (now - this.lastPrune > 1000) this.prune(now)
    if (!wellFormed(frag)) return
    const h = frag.header
    const id = `${h.channel}:${h.audio ? 'a' : 'v'}:${h.epoch}:${h.frameSeq}`
    let st = this.frames.get(id)
    if (!st) {
      st = {
        k: h.k,
        m: h.m,
        frameLen: h.frameLen,
        pieces: new Array(h.k + h.m),
        partial: new Map(),
        completePieces: 0,
        replay: false,
        done: false,
        firstSeenAt: now,
        header: h,
      }
      this.frames.set(id, st)
    }
    if (st.done || st.pieces[h.pieceIdx]) return
    // Drop fragments whose shape disagrees with the frame's first fragment.
    if (h.k !== st.k || h.m !== st.m || h.frameLen !== st.frameLen) return

    let ps = st.partial.get(h.pieceIdx)
    if (!ps) {
      ps = { chunks: new Array(h.fragCount), received: 0 }
      st.partial.set(h.pieceIdx, ps)
    }
    if (ps.chunks[h.fragIdx]) return
    ps.chunks[h.fragIdx] = frag.payload
    ps.received++
    if (h.replay) st.replay = true

    if (ps.received === ps.chunks.length) {
      const P = pieceLength(st.frameLen, st.k)
      const piece = new Uint8Array(P)
      ps.chunks.forEach((c, i) => piece.set(c!, i * MAX_FRAGMENT_PAYLOAD))
      st.pieces[h.pieceIdx] = piece
      st.partial.delete(h.pieceIdx)
      st.completePieces++
      if (st.completePieces >= st.k) this.complete(st, now)
    }
  }

  private complete(st: FrameState, now: number): void {
    const data = decodePieces(st.pieces, st.k, st.m, st.frameLen)
    if (!data) return
    st.done = true
    st.pieces = []
    st.partial.clear()
    const h = st.header
    this.onFrame({
      epoch: h.epoch,
      seq: h.frameSeq,
      gopId: h.gopId,
      refSeq: h.refSeq,
      key: h.key,
      layer: h.layer,
      audio: h.audio,
      captureTime: h.captureTime,
      data,
      replay: st.replay,
      completedAt: now,
    })
  }

  private prune(now: number): void {
    this.lastPrune = now
    for (const [id, st] of this.frames) {
      if (now - st.firstSeenAt > RETAIN_MS) {
        if (!st.done && !st.header.audio) this.incomplete++
        this.frames.delete(id)
      }
    }
  }

  get pending(): number {
    let n = 0
    for (const st of this.frames.values()) if (!st.done) n++
    return n
  }
}
