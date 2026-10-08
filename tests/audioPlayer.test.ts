import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayer } from '../src/media/audio'
import { PlayoutClock } from '../src/media/jitterBuffer'
import type { AssembledFrame } from '../src/media/reassembler'
import { wallClock } from '../src/net/clock'
import { NO_REF } from '../src/proto/framing'
import { AUDIO_FRAME_MS } from '../src/session/capacity'

/** Sequence numbers handed to the decoder, in order (each frame's data is its seq). */
let decoded: number[]
let output: ((d: unknown) => void) | null
/** Start times of buffers scheduled in direct (no worklet) playback. */
let starts: number[]

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.advanceTimersByTime(10_000)
  // No audioWorklet: the player falls back to scheduling buffers directly.
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      currentTime = 5
      destination = {}
      createGain() {
        return { connect() {}, gain: { value: 1 } }
      }
      addEventListener() {}
      removeEventListener() {}
      resume() {
        return Promise.resolve()
      }
      close() {
        return Promise.resolve()
      }
      createBuffer() {
        return { copyToChannel() {} }
      }
      createBufferSource() {
        return { connect() {}, start: (t: number) => starts.push(t) }
      }
    },
  )
  vi.stubGlobal(
    'AudioDecoder',
    class {
      state = 'unconfigured'
      constructor(init: { output: (d: unknown) => void }) {
        output = init.output
      }
      configure() {
        this.state = 'configured'
      }
      decode(chunk: { data: Uint8Array }) {
        decoded.push(chunk.data[0])
      }
      close() {
        this.state = 'closed'
      }
    },
  )
  vi.stubGlobal(
    'EncodedAudioChunk',
    class {
      constructor(init: object) {
        Object.assign(this, init)
      }
    },
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const INFO = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 }

/** A playout clock that plays every frame at its capture time (zero delay); not ready until `ready`. */
function clock(ready = true): PlayoutClock {
  const c = new PlayoutClock({ safetyMs: 0, minDelayMs: 0 })
  if (ready) c.addSample(wallClock(), wallClock())
  return c
}

/** Played on clock `c`, as Player does: each frame's render time read when it arrives. */
function player(c = clock()): AudioPlayer & { clock: PlayoutClock } {
  const p = Object.assign(new AudioPlayer(), { clock: c })
  p.enable()
  p.configure(INFO)
  return p
}

/** Audio frame `seq`, to be heard `dueInMs` from now. */
function frame(seq: number, dueInMs: number): AssembledFrame {
  const now = wallClock()
  return { epoch: 0, seq, gopId: 0, refSeq: NO_REF, key: true, layer: 0, audio: true, captureTime: now + dueInMs, data: new Uint8Array([seq]), replay: false, completedAt: now }
}

function push(p: AudioPlayer & { clock: PlayoutClock }, seq: number, dueInMs: number): void {
  const f = frame(seq, dueInMs)
  p.push(f, p.clock.renderAt(f.captureTime))
}

beforeEach(() => {
  decoded = []
  starts = []
  output = null
})

describe('AudioPlayer reorder buffer', () => {
  it('decodes frames in sequence order whatever order they complete in', () => {
    const p = player()
    push(p, 10, 500)
    expect(decoded).toEqual([10])
    push(p, 12, 580)
    push(p, 13, 620)
    expect(decoded).toEqual([10])
    push(p, 11, 540)
    expect(decoded).toEqual([10, 11, 12, 13])
    expect(p.stats.skipped).toBe(0)
  })

  it('starts from the first frame it gets, and drops duplicates and stragglers', () => {
    const p = player()
    push(p, 20, 500)
    push(p, 20, 500)
    push(p, 19, 460)
    push(p, 21, 540)
    push(p, 21, 540)
    expect(decoded).toEqual([20, 21])
  })

  it('waits for a missing frame until the next one is due within a frame time, then skips it', () => {
    const p = player()
    push(p, 1, 200)
    push(p, 3, 300)
    push(p, 4, 340)
    expect(decoded).toEqual([1])
    vi.advanceTimersByTime(300 - AUDIO_FRAME_MS - 5)
    p.pump()
    expect(decoded).toEqual([1])
    vi.advanceTimersByTime(10)
    p.pump()
    expect(decoded).toEqual([1, 3, 4])
    expect(p.stats.skipped).toBe(1)
    // Too late now: the gap was skipped.
    push(p, 2, 0)
    expect(decoded).toEqual([1, 3, 4])
  })

  it('gives up on a missing frame by when the next was due on arrival, even while the delay rises', () => {
    const c = clock()
    const p = player(c)
    push(p, 1, 100)
    push(p, 3, 200)
    // A stalled path: late frames raise the playout delay about as fast as time passes, which
    // would keep pushing frame 3's render time out if it were re-read from the clock.
    for (let t = 0; t < 200; t += 20) {
      vi.advanceTimersByTime(20)
      c.addSample(wallClock() - 3000, wallClock())
      p.pump()
    }
    expect(c.renderAt(0)!).toBeGreaterThan(150)
    expect(decoded).toEqual([1, 3])
  })

  it('skips at once when the next available frame is already due, counting every missing one', () => {
    const p = player()
    push(p, 1, 100)
    push(p, 5, AUDIO_FRAME_MS)
    expect(decoded).toEqual([1, 5])
    expect(p.stats.skipped).toBe(3)
  })

  it('ignores frames before the playout clock is ready, and starts over on a new configuration', () => {
    const c = clock(false)
    const p = player(c)
    p.push(frame(1, 100), c.renderAt(0))
    expect(decoded).toEqual([])
    c.addSample(wallClock(), wallClock())
    push(p, 7, 100)
    push(p, 8, 140)
    p.configure({ ...INFO, numberOfChannels: 1 })
    // Ordering restarts from whatever comes first.
    push(p, 3, 100)
    expect(decoded).toEqual([7, 8, 3])
  })

  it('plays each decoded chunk at its frame’s render time', () => {
    const p = player()
    push(p, 1, 100)
    push(p, 2, 140)
    const data = { numberOfChannels: 2, numberOfFrames: 1920, sampleRate: 48000, copyTo() {}, close() {} }
    output!(data)
    output!(data)
    // currentTime 5 s; the first chunk is due in 100 ms and the second follows it back to back.
    expect(starts[0]).toBeCloseTo(5.1, 6)
    expect(starts[1]).toBeCloseTo(5.14, 6)
    expect(p.stats.played).toBe(2)
  })
})
