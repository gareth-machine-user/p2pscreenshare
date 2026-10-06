import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYFRAME_GATE, KeyframeGate } from '../src/topology/policy'

describe('KeyframeGate', () => {
  it('bounds a lone requester spamming every 500 ms, with doubling intervals', () => {
    const gate = new KeyframeGate()
    const granted: number[] = []
    for (let t = 0; t <= 60_000; t += 500) if (gate.request('a', t)) granted.push(t)
    expect(granted.length).toBeLessThanOrEqual(8)
    expect(granted).toEqual([0, 4000, 12_000, 22_000, 32_000, 42_000, 52_000])
    const gaps = granted.slice(1).map((t, i) => t - granted[i])
    expect(gaps).toEqual([4000, 8000, 10_000, 10_000, 10_000, 10_000])
  })

  it('serves a first request at once', () => {
    expect(new KeyframeGate().request('a', 1000)).toBe(true)
  })

  it('honours two distinct requesters within the window at once, despite backoff', () => {
    const gate = new KeyframeGate()
    expect(gate.request('a', 0)).toBe(true)
    // Both keep asking and are served by a scheduled keyframe: held until 12 s and 10 s.
    expect(gate.request('a', 1000)).toBe(false)
    expect(gate.request('b', 1100)).toBe(true) // b's first request
    expect(gate.request('a', 1500)).toBe(false)
    expect(gate.request('b', 1600)).toBe(false)
    gate.onKeyframe(2000)
    // Alone, a is still held...
    expect(gate.request('a', 6500)).toBe(false)
    // ...but b asking too, within the crowd window, means a real upstream problem.
    expect(gate.request('b', 7000)).toBe(true)
  })

  it('does not let two viewers served moments ago form a crowd', () => {
    const gate = new KeyframeGate()
    gate.request('a', 0)
    gate.request('b', 100)
    gate.onKeyframe(500)
    expect(gate.request('a', 1000)).toBe(false)
    expect(gate.request('b', 1200)).toBe(false)
  })

  it('respects the global minimum interval, even for a crowd', () => {
    const gate = new KeyframeGate()
    expect(gate.request('a', 0)).toBe(true)
    expect(gate.request('b', DEFAULT_KEYFRAME_GATE.globalMinIntervalMs - 1)).toBe(false)
    expect(gate.request('b', DEFAULT_KEYFRAME_GATE.globalMinIntervalMs)).toBe(true)
  })

  it('counts a scheduled keyframe as serving waiting viewers', () => {
    const gate = new KeyframeGate()
    gate.request('a', 0) // served, held 4 s
    gate.request('a', 1000) // waiting
    gate.onKeyframe(2000) // the scheduled keyframe serves it: held until 2000 + 8000
    expect(gate.request('a', 5000)).toBe(false)
    expect(gate.request('a', 9500)).toBe(false)
    expect(gate.request('a', 10_000)).toBe(true)
  })

  it('resets the backoff after the viewer stops asking for a while', () => {
    const gate = new KeyframeGate()
    for (let t = 0; t <= 20_000; t += 500) gate.request('a', t)
    // Backed off to 10 s; quiet for over 2 × 10 s.
    expect(gate.request('a', 50_000)).toBe(true)
    expect(gate.request('a', 50_500)).toBe(false)
    // Back to the minimum interval.
    expect(gate.request('a', 54_000)).toBe(true)
  })

  it('forgets a viewer', () => {
    const gate = new KeyframeGate()
    for (let t = 0; t <= 20_000; t += 500) gate.request('a', t)
    expect(gate.request('a', 20_500)).toBe(false)
    gate.forget('a')
    expect(gate.request('a', 21_000)).toBe(true)
  })
})
