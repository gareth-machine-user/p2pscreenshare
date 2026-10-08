/**
 * A sliding time window of values kept sorted as they come and go, for order statistics (min,
 * quantiles) without re-sorting the window on every sample. Samples must be added in time order.
 */
export class SortedWindow {
  /** Samples in arrival (time) order, for expiry. */
  private byTime: { at: number; value: number }[] = []
  private head = 0
  /** The same values, ascending. */
  private sorted: number[] = []

  add(at: number, value: number): void {
    this.byTime.push({ at, value })
    this.sorted.splice(this.lowerBound(value), 0, value)
  }

  /** Drops samples older than `cutoff` (at < cutoff). */
  expire(cutoff: number): void {
    while (this.head < this.byTime.length && this.byTime[this.head].at < cutoff) {
      // Any equal value will do: they are indistinguishable.
      this.sorted.splice(this.lowerBound(this.byTime[this.head].value), 1)
      this.head++
    }
    // Compact now and then rather than shifting on every expiry.
    if (this.head > 64 && this.head * 2 > this.byTime.length) {
      this.byTime = this.byTime.slice(this.head)
      this.head = 0
    }
  }

  get size(): number {
    return this.sorted.length
  }

  get min(): number | undefined {
    return this.sorted[0]
  }

  /** The value at index floor(size * q) of the sorted window (clamped to the last). */
  quantile(q: number): number | undefined {
    const n = this.sorted.length
    return n ? this.sorted[Math.min(n - 1, Math.floor(n * q))] : undefined
  }

  /** First index whose value is >= `v`. */
  private lowerBound(v: number): number {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.sorted[mid] < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}
