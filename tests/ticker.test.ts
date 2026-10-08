import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { after, every, resetTicker } from '../src/net/ticker'

describe('ticker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    resetTicker()
  })
  afterEach(() => {
    resetTicker()
    vi.useRealTimers()
  })

  it('runs repeating and one-shot tasks', () => {
    const rep = vi.fn()
    const once = vi.fn()
    every(100, rep)
    after(100, once)
    vi.advanceTimersByTime(350)
    expect(rep).toHaveBeenCalledTimes(3)
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('does not run a task cancelled by another task due in the same tick', () => {
    const b = vi.fn()
    let cancelB = () => {}
    after(100, () => cancelB())
    cancelB = after(100, b)
    vi.advanceTimersByTime(200)
    expect(b).not.toHaveBeenCalled()
  })

  it('stops a repeating task once cancelled', () => {
    const fn = vi.fn()
    const cancel = every(100, fn)
    vi.advanceTimersByTime(150)
    cancel()
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
