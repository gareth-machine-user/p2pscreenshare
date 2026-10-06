// Periodic and delayed callbacks driven by a dedicated worker.
//
// Browsers throttle main-thread timers in background tabs: to once a second, and after a few
// minutes hidden to about once a minute. A presenter's lobby tab is usually in the background
// while it shares another window, yet its heartbeats, replans and idle refreshes must keep
// running (otherwise viewers think it is gone and the stream stalls). Dedicated workers' timers
// aren't throttled that way, and a message from the worker wakes the main thread.

interface Task {
  /** Repeat period, or 0 for a one-shot. */
  every: number
  due: number
  fn: () => void
}

const BASE_MS = 50
const tasks = new Set<Task>()
/** Stops the running base timer; null until started. */
let stopBase: (() => void) | null = null

/** The longest a due task waited for the main thread since the last takeMainThreadLag() (ms). */
let maxLagMs = 0

function run(): void {
  const now = performance.now()
  for (const t of [...tasks]) {
    if (now < t.due) continue
    // The worker ticks every 50 ms whatever the tab's state: a task much later than that waited
    // for the main thread (a long task, GC, an overloaded machine).
    maxLagMs = Math.max(maxLagMs, now - t.due - BASE_MS)
    if (t.every > 0) t.due = now + t.every
    else tasks.delete(t)
    try {
      t.fn()
    } catch (e) {
      console.error(e)
    }
  }
}

function start(): void {
  if (stopBase) return
  try {
    const src = `setInterval(() => postMessage(0), ${BASE_MS})`
    const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    worker.onmessage = run
    stopBase = () => worker.terminate()
  } catch {
    // No workers (e.g. unit tests): plain timers.
    const t = setInterval(run, BASE_MS)
    stopBase = () => clearInterval(t)
  }
}

/** Calls `fn` every `ms` (at ~50 ms resolution). Returns a cancel function. */
export function every(ms: number, fn: () => void): () => void {
  start()
  const t: Task = { every: Math.max(ms, BASE_MS), due: performance.now() + ms, fn }
  tasks.add(t)
  return () => tasks.delete(t)
}

/** Calls `fn` once after `ms`. Returns a cancel function. */
export function after(ms: number, fn: () => void): () => void {
  start()
  const t: Task = { every: 0, due: performance.now() + ms, fn }
  tasks.add(t)
  return () => tasks.delete(t)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => after(ms, r))
}

/**
 * Resolves after `ms`, precisely while the tab is visible (a main-thread timer: the worker only
 * ticks every 50 ms) and at worst at the worker's resolution while main-thread timers are throttled.
 */
export function sleepPrecise(ms: number): Promise<void> {
  return new Promise((r) => {
    const done = () => {
      clearTimeout(t)
      cancel()
      r()
    }
    const t = setTimeout(done, ms)
    const cancel = after(ms, done)
  })
}

/**
 * How long the main thread was unavailable at worst since the last call (ms, beyond the ticker's
 * own 50 ms resolution): the page stalled. Resets on each call.
 */
export function takeMainThreadLag(): number {
  const lag = Math.max(0, maxLagMs)
  maxLagMs = 0
  return lag
}

/** Whether this page is hidden, so its main-thread timers may be throttled (false outside a browser). */
export function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/**
 * Tests only: drops every task and starts again on whatever timers are current, so tests can
 * install fake timers (with a fake `performance.now`) and drive time deterministically.
 */
export function resetTicker(): void {
  tasks.clear()
  stopBase?.()
  stopBase = null
}
