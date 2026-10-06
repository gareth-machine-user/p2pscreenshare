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

function run(): void {
  const now = performance.now()
  for (const t of [...tasks]) {
    if (now < t.due) continue
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
 * Tests only: drops every task and starts again on whatever timers are current, so tests can
 * install fake timers (with a fake `performance.now`) and drive time deterministically.
 */
export function resetTicker(): void {
  tasks.clear()
  stopBase?.()
  stopBase = null
}
