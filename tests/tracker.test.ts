import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STABLE_OPEN_MS, TrackerClient } from '../src/net/tracker'

/** A WebSocket stand-in: tests open and close it by hand. */
class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }
}

describe('TrackerClient reconnects', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const latest = () => FakeSocket.all.at(-1)!

  // random() = 0.5 means no jitter.
  it('doubles the delay while the tracker drops connections early, and resets after a stable one', () => {
    const t = new TrackerClient(['wss://t'], 'hash', 'peer', () => 0.5)
    const nextDialAfterClose = () => {
      const n = FakeSocket.all.length
      let waited = 0
      while (FakeSocket.all.length === n) {
        vi.advanceTimersByTime(100)
        waited += 100
      }
      return waited
    }
    latest().open()
    latest().close()
    expect(nextDialAfterClose()).toBe(1000)
    latest().open()
    latest().close()
    expect(nextDialAfterClose()).toBe(2000)
    latest().open()
    latest().close()
    expect(nextDialAfterClose()).toBe(4000)
    // Open long enough: the backoff starts over.
    latest().open()
    vi.advanceTimersByTime(STABLE_OPEN_MS)
    latest().close()
    expect(nextDialAfterClose()).toBe(1000)
    t.close()
  })

  it('spreads reconnect delays with jitter', () => {
    const low = new TrackerClient(['wss://a'], 'hash', 'peer', () => 0)
    latest().close()
    const n = FakeSocket.all.length
    vi.advanceTimersByTime(749)
    expect(FakeSocket.all.length).toBe(n)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all.length).toBe(n + 1)
    low.close()
  })

  it('stops reconnecting once closed', () => {
    const t = new TrackerClient(['wss://t'], 'hash', 'peer', () => 0.5)
    latest().close()
    t.close()
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.all.length).toBe(1)
  })
})
