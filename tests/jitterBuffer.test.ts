import { describe, expect, it } from 'vitest'
import { DecodeScheduler, PlayoutClock } from '../src/media/jitterBuffer'
import type { AssembledFrame } from '../src/media/reassembler'
import { NO_REF } from '../src/proto/framing'

// L1T3 pattern: seq%4 -> layer 0,2,1,2 ; keyframe every 8 frames in these tests.
function makeFrame(seq: number, captureTime = seq * 33): AssembledFrame {
  const pos = seq % 4
  const layer = [0, 2, 1, 2][pos]
  const key = seq % 8 === 0
  let refSeq = NO_REF
  if (!key) refSeq = layer === 0 ? seq - 4 : layer === 1 ? seq - 2 : seq - 1
  return {
    epoch: 1,
    seq,
    gopId: seq - (seq % 8),
    refSeq,
    key,
    layer,
    audio: false,
    captureTime,
    data: new Uint8Array(1),
    replay: false,
    completedAt: captureTime + 50,
  }
}

function readyClock(): PlayoutClock {
  const c = new PlayoutClock({ safetyMs: 0, minDelayMs: 0 })
  c.addSample(0, 50) // transit 50ms
  return c
}

describe('DecodeScheduler', () => {
  it('waits for a keyframe, then decodes in order', () => {
    const s = new DecodeScheduler(readyClock())
    s.push(makeFrame(3))
    expect(s.poll(0)).toEqual([])
    for (const seq of [9, 8, 10]) s.push(makeFrame(seq))
    expect(s.poll(0).map((f) => f.seq)).toEqual([8, 9, 10])
  })

  it('waits for a missing frame until the next frame is nearly due, then skips it', () => {
    const s = new DecodeScheduler(readyClock(), undefined, 10)
    s.push(makeFrame(0))
    s.push(makeFrame(2)) // seq 1 (T2) missing; frame 2 refs 0
    expect(s.poll(0).map((f) => f.seq)).toEqual([0])
    // frame 2 renders at 66 + 50 = 116
    expect(s.poll(100).map((f) => f.seq)).toEqual([])
    expect(s.poll(110).map((f) => f.seq)).toEqual([2])
    expect(s.stats.skippedMissing).toBe(1)
  })

  it('drops frames whose reference is lost and recovers at the next keyframe', () => {
    let needKey = 0
    const s = new DecodeScheduler(readyClock(), () => needKey++, 1000)
    s.push(makeFrame(0))
    // seq 4 (T0) lost -> 5,6,7 depend on it transitively
    for (const seq of [1, 2, 3, 5, 6, 7]) s.push(makeFrame(seq))
    expect(s.poll(0).map((f) => f.seq)).toEqual([0, 1, 2, 3])
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([])
    expect(needKey).toBe(1)
    expect(s.waitingForKeyframe).toBe(true)
    s.push(makeFrame(8))
    s.push(makeFrame(9))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([8, 9])
  })

  it('tolerates dropped T2 frames without breaking the chain', () => {
    const s = new DecodeScheduler(readyClock(), undefined, 1000)
    for (const seq of [0, 2, 4, 6, 8]) s.push(makeFrame(seq)) // only T0/T1
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([0, 2, 4, 6, 8])
    expect(s.stats.droppedUndecodable).toBe(0)
  })

  it('gives out-of-order replayed frames time to arrive before skipping', () => {
    const s = new DecodeScheduler(readyClock(), undefined, 15, 100)
    // GOP-cache replay: captured long ago (already past due), arriving now from several parents.
    const replay = (seq: number, at: number) => ({ ...makeFrame(seq, seq * 33 - 10_000), replay: true, completedAt: at })
    s.push(replay(8, 1000))
    expect(s.poll(1000).map((f) => f.seq)).toEqual([8])
    s.push(replay(10, 1005)) // refs 8; 9 still in flight on another stripe parent
    expect(s.poll(1005).map((f) => f.seq)).toEqual([])
    s.push(replay(9, 1020))
    expect(s.poll(1020).map((f) => f.seq)).toEqual([9, 10])
    expect(s.stats.skippedMissing).toBe(0)
    // A replayed frame that really is missing is skipped once the grace has passed.
    s.push(replay(12, 1030))
    expect(s.poll(1100).map((f) => f.seq)).toEqual([])
    expect(s.poll(1130).map((f) => f.seq)).toEqual([12])
    expect(s.stats.skippedMissing).toBe(1)
  })
})

describe('PlayoutClock', () => {
  it('targets the configured quantile of transit times', () => {
    const c = new PlayoutClock({ safetyMs: 0, slewMsPerSec: 1e9, minDelayMs: 0 })
    for (let i = 0; i < 100; i++) c.addSample(i * 10, i * 10 + 100 + (i % 10 === 0 ? 300 : 0))
    // 90% of transits are 100ms, 10% are 400ms -> 95th percentile is 400
    expect(c.renderAt(0)).toBe(400)
    expect(c.bufferMs).toBe(300)
  })
})
