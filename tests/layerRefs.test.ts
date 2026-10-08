import { describe, expect, it } from 'vitest'
import { LayerRefs } from '../src/media/layerRefs'
import { NO_REF } from '../src/proto/framing'

/** [seq, gopId, refSeq, layer] for each (key, layer) in turn. */
function run(frames: [boolean, number][], r = new LayerRefs()): [number, number, number, number][] {
  return frames.map(([key, layer]) => {
    const f = r.next(key, layer)
    return [f.seq, f.gopId, f.refSeq, f.layer]
  })
}

describe('LayerRefs', () => {
  it('L1T3: T0 refs the previous T0, T1 the last T0, T2 the latest lower-layer frame', () => {
    // The L1T3 pattern: T0 T2 T1 T2 T0 T2 T1 T2 ...
    const pattern: [boolean, number][] = [[true, 0], [false, 2], [false, 1], [false, 2], [false, 0], [false, 2], [false, 1], [false, 2], [false, 0]]
    expect(run(pattern)).toEqual([
      [0, 0, NO_REF, 0],
      [1, 0, 0, 2],
      [2, 0, 0, 1],
      [3, 0, 2, 2],
      [4, 0, 0, 0],
      [5, 0, 4, 2],
      [6, 0, 4, 1],
      [7, 0, 6, 2],
      [8, 0, 4, 0],
    ])
  })

  it('a keyframe starts a new GOP, forgets older references, and is always layer 0', () => {
    const r = new LayerRefs()
    run([[true, 0], [false, 1], [false, 2]], r)
    expect(run([[true, 2], [false, 2], [false, 1]], r)).toEqual([
      [3, 3, NO_REF, 0],
      [4, 3, 3, 2],
      [5, 3, 3, 1],
    ])
  })

  it('a lower layer frame invalidates higher layers’ older references', () => {
    // T0 T1 T2 T0 T2: the last T2 must ref the new T0, not the T1 from before it.
    expect(run([[true, 0], [false, 1], [false, 2], [false, 0], [false, 2]]).map((f) => f[2])).toEqual([NO_REF, 0, 1, 0, 3])
  })

  it('without temporal layers each frame refs the previous one', () => {
    expect(run([[true, 0], [false, 0], [false, 0]]).map((f) => f[2])).toEqual([NO_REF, 0, 1])
  })

  it('a delta frame before any keyframe refs the previous seq', () => {
    // -1 for the very first frame: NO_REF once written as a u32.
    expect(run([[false, 1]])[0][2]).toBe(-1)
    expect(run([[false, 0], [false, 2]]).map((f) => f[2])).toEqual([-1, 0])
  })
})
