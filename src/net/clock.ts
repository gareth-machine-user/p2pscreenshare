/** Wall-clock time (ms) with sub-millisecond resolution. */
export function wallClock(): number {
  return performance.timeOrigin + performance.now()
}
