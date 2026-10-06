// Deterministic time for multi-peer tests.
//
// Timers, Date and performance.now are faked (vitest), and the ticker restarts on them. The only
// real asynchrony left is WebCrypto (Ed25519 signing and verification run off-thread), so its calls
// are serialized: each starts after the previous one finished, and results arrive in call order.
// `advance` moves time in small steps and lets all crypto (and what it triggers) finish between
// steps, with fake time standing still, so a run doesn't depend on how fast the machine is.
import { vi } from 'vitest'
import { resetTicker } from '../../src/net/ticker'

const STEP_MS = 10

type Subtle = Record<string, (...args: unknown[]) => Promise<unknown>>
const METHODS = ['sign', 'verify', 'digest', 'importKey', 'exportKey', 'generateKey', 'encrypt', 'decrypt', 'deriveKey', 'deriveBits'] as const

let inflight = 0
let queue: Promise<unknown> = Promise.resolve()

const realImmediate = () => new Promise<void>((r) => setImmediate(r))

/** Installs fake time (starting at `startMs` wall clock) and the crypto queue. Call in beforeEach. */
export function installClock(startMs = Date.UTC(2026, 0, 1)): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'], now: startMs })
  resetTicker()
  const subtle = crypto.subtle as unknown as Subtle
  for (const m of METHODS) {
    const real = subtle[m].bind(crypto.subtle)
    vi.spyOn(subtle, m).mockImplementation((...args: unknown[]) => {
      inflight++
      const p = queue.then(() => real(...args))
      const done = () => inflight--
      queue = p.then(done, done)
      return p
    })
  }
}

/** Undoes installClock. Call in afterEach. */
export function uninstallClock(): void {
  resetTicker()
  vi.restoreAllMocks()
  vi.useRealTimers()
}

/** Lets pending crypto, and everything it triggers, run to completion (fake time stands still). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    await queue
    await realImmediate()
    if (inflight === 0) return
  }
  throw new Error('crypto never settled')
}

/** Moves fake time forward by `ms`, settling after each small step. */
export async function advance(ms: number): Promise<void> {
  await settle()
  for (let left = ms; left > 0; left -= STEP_MS) {
    vi.advanceTimersByTime(Math.min(STEP_MS, left))
    await settle()
  }
}

/** Advances until `cond` holds, failing after `limitMs` of fake time. Returns the time it took. */
export async function until(cond: () => boolean, limitMs: number, what = 'condition'): Promise<number> {
  const start = performance.now()
  await settle()
  while (!cond()) {
    if (performance.now() - start > limitMs) throw new Error(`${what} not reached within ${limitMs} ms`)
    await advance(STEP_MS)
  }
  return performance.now() - start
}
