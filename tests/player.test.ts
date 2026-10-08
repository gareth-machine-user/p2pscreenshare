import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Player } from '../src/media/player'
import type { AssembledFrame } from '../src/media/reassembler'
import { wallClock } from '../src/net/clock'
import { NO_REF } from '../src/proto/framing'
import type { StreamInfo } from '../src/proto/messages'

/** [epoch, seq] of each chunk handed to a decoder, in order. */
let decoded: [number, number][]
/** Epoch each decoder was configured for, in creation order. */
let configured: number[]

// Fake timers before the ticker's first use (it starts once per module instance).
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.advanceTimersByTime(10_000)
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // Just enough WebCodecs: the chunk's timestamp carries [epoch, seq] (see frame()).
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'unconfigured'
      configure(c: { codedWidth: number }) {
        configured.push(c.codedWidth)
        this.state = 'configured'
      }
      decode(chunk: { timestamp: number }) {
        const v = chunk.timestamp - base * 1000
        decoded.push([Math.floor(v / 100), v % 100])
      }
      close() {
        this.state = 'closed'
      }
    },
  )
  vi.stubGlobal(
    'EncodedVideoChunk',
    class {
      timestamp: number
      constructor(init: { timestamp: number }) {
        this.timestamp = init.timestamp
      }
    },
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

let base = 0
beforeEach(() => {
  decoded = []
  configured = []
  base = Math.floor(wallClock())
})

/** StreamInfo for `epoch`; codedWidth doubles as the epoch so the stub can tell decoders apart. */
const info = (epoch: number): StreamInfo => ({ epoch, codec: 'vp8', codedWidth: epoch, codedHeight: 480 })

/** Frame `seq` (< 100) of `epoch`, captured now; the µs of its capture time encode [epoch, seq] for the stub. */
function frame(epoch: number, seq: number, key = false): AssembledFrame {
  const captureTime = base + (epoch * 100 + seq) / 1000
  return { epoch, seq, gopId: 0, refSeq: key ? NO_REF : seq - 1, key, layer: 0, audio: false, captureTime, data: new Uint8Array(1), replay: false, completedAt: captureTime }
}

/** Sets the StreamInfo and lets the player's drain tick feed what it now holds to the decoder. */
function announce(p: Player, i: StreamInfo, force = false): void {
  p.setStreamInfo(i, force)
  vi.advanceTimersByTime(60)
}

function player(): { p: Player; keyRequests: () => number } {
  let n = 0
  const p = new Player(null, () => n++)
  return { p, keyRequests: () => n }
}

describe('Player epoch switching', () => {
  it('holds a new epoch’s frames until its StreamInfo, then decodes them from its keyframe without asking for one', () => {
    const { p, keyRequests } = player()
    announce(p, info(1))
    p.push(frame(1, 0, true))
    p.push(frame(1, 1))
    expect(decoded).toEqual([[1, 0], [1, 1]])
    // The publisher rebuilt its encoder: epoch 2 frames overtake its StreamInfo.
    p.push(frame(2, 0, true))
    p.push(frame(2, 1))
    expect(decoded).toHaveLength(2)
    const before = keyRequests()
    announce(p, info(2))
    expect(configured).toEqual([1, 2])
    expect(decoded.slice(2)).toEqual([[2, 0], [2, 1]])
    expect(keyRequests()).toBe(before)
    p.close()
  })

  it('decodes held frames as soon as their StreamInfo configures the decoder, once each and in order', () => {
    const { p } = player()
    announce(p, info(1))
    p.push(frame(2, 0, true))
    p.push(frame(2, 1))
    // No drain tick in between: they must not wait up to 50 ms for one.
    p.setStreamInfo(info(2))
    expect(decoded).toEqual([[2, 0], [2, 1]])
    p.push(frame(2, 2))
    vi.advanceTimersByTime(60)
    expect(decoded).toEqual([[2, 0], [2, 1], [2, 2]])
    p.close()
  })

  it('drops late frames of the epoch it just replaced instead of holding them', () => {
    const { p } = player()
    announce(p, info(1))
    p.push(frame(1, 0, true))
    announce(p, info(2))
    p.push(frame(3, 0, true))
    // A straggler of the retired epoch: held as "early", it would push out epoch 3's keyframe.
    p.push(frame(1, 1))
    announce(p, info(3))
    expect(decoded).toEqual([[1, 0], [3, 0]])
    p.close()
  })

  it('holds only the newest unannounced epoch', () => {
    const { p } = player()
    announce(p, info(1))
    p.push(frame(2, 0, true))
    p.push(frame(3, 0, true))
    p.push(frame(3, 1))
    announce(p, info(2))
    // Epoch 2's keyframe was discarded when epoch 3's frames arrived.
    expect(decoded).toEqual([])
    announce(p, info(3))
    expect(decoded).toEqual([[3, 0], [3, 1]])
    p.close()
  })

  it('asks for a keyframe when the decoder is rebuilt within an epoch and none is in hand', () => {
    const { p, keyRequests } = player()
    announce(p, info(1))
    const before = keyRequests()
    announce(p, info(1), true)
    expect(keyRequests()).toBe(before + 1)
    p.close()
  })
})
