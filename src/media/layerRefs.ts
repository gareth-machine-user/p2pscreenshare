import { NO_REF } from '../proto/framing'

export interface FrameRefs {
  seq: number
  gopId: number
  refSeq: number
  layer: number
}

/**
 * Numbers encoded video frames and works out what each references, for an L1Tn temporal-layer
 * structure: a keyframe starts a GOP; Tn references the most recent frame of a lower layer; T0
 * references the previous T0. Receivers use refSeq to never decode a frame whose reference is
 * missing. Sequence numbers run on across encoder rebuilds (epochs).
 */
export class LayerRefs {
  private seq = 0
  private gopId = 0
  private lastSeqByLayer: number[] = []

  /** `layer` is the encoder's temporal layer id (ignored for keyframes, which are layer 0). */
  next(key: boolean, layer: number): FrameRefs {
    if (key) layer = 0
    const seq = this.seq
    this.seq = (this.seq + 1) >>> 0
    let refSeq = NO_REF
    if (key) {
      this.gopId = seq
      this.lastSeqByLayer = []
    } else {
      const lower = layer === 0 ? [this.lastSeqByLayer[0]] : this.lastSeqByLayer.slice(0, layer)
      const refs = lower.filter((x) => x !== undefined)
      refSeq = refs.length ? Math.max(...refs) : seq - 1
    }
    this.lastSeqByLayer[layer] = seq
    // A frame of layer L invalidates higher layers' references to older frames.
    this.lastSeqByLayer.length = layer + 1
    return { seq, gopId: this.gopId, refSeq, layer }
  }
}
