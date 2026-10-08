import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { after, debounce, every, resetTicker } from '../src/net/ticker'

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

  it('debounce: keeps a pending call, unless asked again with delay 0', () => {
    const fn = vi.fn()
    const d = debounce(fn)
    d.schedule(200)
    vi.advanceTimersByTime(100)
    d.schedule(200) // still due at 200, not pushed back
    vi.advanceTimersByTime(150)
    expect(fn).toHaveBeenCalledTimes(1)
    d.schedule(500)
    d.schedule(0) // replaces it: runs now, once
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('debounce: cancel drops the pending call, and scheduling works again after', () => {
    const fn = vi.fn()
    const d = debounce(fn)
    d.schedule(100)
    d.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
    d.schedule(100)
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
