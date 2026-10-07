import { describe, expect, it } from 'vitest'
import { DecodeScheduler, EXTRA_BUFFER_MS, PlayoutClock } from '../src/media/jitterBuffer'
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

  it('keeps frames encoded until they are within the decode-ahead window', () => {
    const s = new DecodeScheduler(readyClock())
    for (let seq = 0; seq < 8; seq++) s.push(makeFrame(seq)) // frame n renders at 33n + 50
    expect(s.poll(0, 100).map((f) => f.seq)).toEqual([0, 1])
    expect(s.poll(0, 100)).toEqual([])
    expect(s.poll(100, 100).map((f) => f.seq)).toEqual([2, 3, 4])
    expect(s.buffered).toBe(3)
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

  it('restarts a broken chain from a replayed GOP behind the decode position', () => {
    let needKey = 0
    const s = new DecodeScheduler(readyClock(), () => needKey++, 1000)
    const replay = (seq: number) => ({ ...makeFrame(seq), replay: true })
    for (const seq of [0, 1, 2, 3]) s.push(makeFrame(seq))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([0, 1, 2, 3])
    // Replayed repeats of decoded frames are dropped, and not counted as late.
    s.push(replay(0))
    expect(s.poll(10_000)).toEqual([])
    expect(s.stats.droppedLate).toBe(0)
    // T0 frame 4 was lost: 5 and 6 can't be decoded, and the chain breaks.
    for (const seq of [5, 6]) s.push(makeFrame(seq))
    expect(s.poll(10_000)).toEqual([])
    expect(needKey).toBe(1)
    // The parents' replay: the keyframe and base layer, including the lost frame.
    for (const seq of [0, 4]) s.push(replay(seq))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([0, 4])
    expect(s.waitingForKeyframe).toBe(false)
    expect(s.stats.droppedLate).toBe(0)
    // Repeats behind the position are dropped again once decoding.
    s.push(replay(4))
    expect(s.poll(10_000)).toEqual([])
  })

  it('ignores epochs: a restart with lower seqs needs a reset, which the player does on a new epoch', () => {
    let needKey = 0
    const s = new DecodeScheduler(readyClock(), () => needKey++, 1000)
    for (let seq = 16; seq < 20; seq++) s.push(makeFrame(seq))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([16, 17, 18, 19])
    // The publisher restarted its encoder: seqs start over in a new epoch.
    const restarted = (seq: number) => ({ ...makeFrame(seq), epoch: 2 })
    s.push(restarted(0))
    expect(s.stats.droppedLate).toBe(1)
    expect(s.poll(10_000)).toEqual([])
    // Player.setStreamInfo for the new epoch: reset without asking for a key (one is coming).
    s.reset(false)
    expect(needKey).toBe(0)
    for (const seq of [0, 1, 2]) s.push(restarted(seq))
    expect(s.poll(10_000).map((f) => [f.epoch, f.seq])).toEqual([
      [2, 0],
      [2, 1],
      [2, 2],
    ])
    expect(needKey).toBe(0)
    // A reset that does request one (decoder rebuilt within an epoch).
    s.reset()
    expect(needKey).toBe(1)
    expect(s.waitingForKeyframe).toBe(true)
  })

  it('requireKeyframe drops delta frames until the next keyframe, asking once', () => {
    let needKey = 0
    const s = new DecodeScheduler(readyClock(), () => needKey++, 1000)
    for (const seq of [0, 1, 2]) s.push(makeFrame(seq))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([0, 1, 2])
    s.requireKeyframe()
    expect(needKey).toBe(1)
    expect(s.waitingForKeyframe).toBe(true)
    // Already waiting: no duplicate request.
    s.requireKeyframe()
    expect(needKey).toBe(1)
    for (const seq of [3, 4, 5]) s.push(makeFrame(seq))
    expect(s.poll(10_000)).toEqual([])
    for (const seq of [8, 9]) s.push(makeFrame(seq))
    expect(s.poll(10_000).map((f) => f.seq)).toEqual([8, 9])
    expect(s.stats.droppedUndecodable).toBe(3)
    expect(s.waitingForKeyframe).toBe(false)
  })
})

describe('PlayoutClock', () => {
  it('is not ready until it has a sample', () => {
    const c = new PlayoutClock()
    expect(c.ready).toBe(false)
    expect(c.renderAt(1000)).toBeNull()
    expect(c.bufferMs).toBe(0)
    c.addSample(1000, 1100)
    expect(c.ready).toBe(true)
  })

  it('keeps at least minDelay of buffer and at most maxDelay', () => {
    const c = new PlayoutClock({ safetyMs: 0, minDelayMs: 150, maxDelayMs: 300, slewMsPerSec: 1e9 })
    for (let i = 0; i < 10; i++) c.addSample(i * 10, i * 10 + 100)
    expect(c.renderAt(0)).toBe(250)
    expect(c.bufferMs).toBe(150)
    // A slow outlier above the quantile cut is capped at maxDelay beyond the fastest path.
    const d = new PlayoutClock({ quantile: 0.99, safetyMs: 0, minDelayMs: 0, maxDelayMs: 300, slewMsPerSec: 1e9 })
    d.addSample(0, 100)
    d.addSample(10, 2010)
    expect(d.bufferMs).toBe(300)
  })

  it('slews the delay: up at 4x the rate, down at the rate', () => {
    const c = new PlayoutClock({ quantile: 0.5, safetyMs: 0, minDelayMs: 0, windowMs: 500, slewMsPerSec: 100, slewDownMsPerSec: 100, holdMs: 0 })
    c.addSample(0, 100)
    expect(c.renderAt(0)).toBe(100)
    // Target jumps to 1000 ms; one second allows +400.
    c.addSample(100, 1100)
    expect(c.renderAt(0)).toBe(500)
    // The slow samples age out; target falls back to 100 but the delay only drops 100 ms/s.
    c.addSample(2000, 2100)
    expect(c.renderAt(0)).toBeCloseTo(400, 6)
    c.addSample(3000, 3100)
    expect(c.renderAt(0)).toBeCloseTo(300, 6)
  })

  it('keeps the buffer a spike needed for holdMs, then glides down', () => {
    const c = new PlayoutClock({ quantile: 0.99, safetyMs: 0, minDelayMs: 0, windowMs: 1000, slewMsPerSec: 1e9, slewDownMsPerSec: 100, holdMs: 30_000 })
    // Steady 100 ms transit, then one 600 ms spike at t=1 s.
    for (let t = 0; t <= 1000; t += 20) c.addSample(t, t + 100)
    c.addSample(1000, 1600)
    expect(c.bufferMs).toBe(500)
    // The spike leaves the 1 s window at t=2 s, but the buffer stays for the 30 s hold.
    for (let t = 1020; t <= 30_000; t += 20) c.addSample(t, t + 100)
    expect(c.bufferMs).toBe(500)
    // The hold counts from when the spike was last needed: its sample (completed at 1.6 s) leaves
    // the 1 s window at 2.6 s, so the hold ends at 32.6 s. Then the buffer falls at 100 ms/s.
    for (let t = 30_020; t <= 34_600; t += 20) c.addSample(t, t + 100)
    expect(c.bufferMs).toBeGreaterThan(280)
    expect(c.bufferMs).toBeLessThan(320)
    // Eventually back to the steady need.
    for (let t = 34_620; t <= 40_000; t += 20) c.addSample(t, t + 100)
    expect(c.bufferMs).toBe(0)
  })

  it('a repeated spike within the hold never lets the buffer shrink', () => {
    const c = new PlayoutClock({ quantile: 0.99, safetyMs: 0, minDelayMs: 0, windowMs: 1000, slewMsPerSec: 1e9, slewDownMsPerSec: 100, holdMs: 30_000 })
    let min = Infinity
    for (let t = 0; t <= 120_000; t += 20) {
      // A 400 ms hiccup every 25 s.
      c.addSample(t, t + 100 + (t % 25_000 === 0 ? 400 : 0))
      if (t > 1000) min = Math.min(min, c.bufferMs)
    }
    expect(min).toBe(400)
  })

  it('buffering choices: extra adds a cushion; going lower jumps straight down', () => {
    const c = new PlayoutClock({ quantile: 0.99, safetyMs: 0, minDelayMs: 0, slewMsPerSec: 1e9, slewDownMsPerSec: 10 })
    for (let t = 0; t <= 1000; t += 20) c.addSample(t, t + 100)
    expect(c.bufferMs).toBe(0)
    c.setBuffering('extra')
    c.addSample(1020, 1120)
    expect(c.bufferMs).toBeGreaterThanOrEqual(EXTRA_BUFFER_MS)
    // Back to low: no gliding down at 10 ms/s, the viewer asked for less delay.
    c.setBuffering('low')
    expect(c.bufferMs).toBeLessThan(100)
  })

  it('targets the configured quantile of transit times', () => {
    const c = new PlayoutClock({ safetyMs: 0, slewMsPerSec: 1e9, minDelayMs: 0 })
    for (let i = 0; i < 100; i++) c.addSample(i * 10, i * 10 + 100 + (i % 10 === 0 ? 300 : 0))
    // 90% of transits are 100ms, 10% are 400ms -> 95th percentile is 400
    expect(c.renderAt(0)).toBe(400)
    expect(c.bufferMs).toBe(300)
  })
})
