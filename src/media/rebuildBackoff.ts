/**
 * When to rebuild a codec (encoder or decoder) that keeps failing. The first rebuild after a quiet
 * spell is immediate (a one-off error costs nothing), then the gaps double from `minMs` up to
 * `maxMs`. A config the browser can't handle fails on every attempt; without this the rebuild loop
 * would spin, and each rebuild would also ask for a keyframe. Pure: times come from the caller.
 */
export class RebuildBackoff {
  private attempts = 0
  private lastAt = -Infinity

  constructor(
    private readonly minMs = 1000,
    private readonly maxMs = 10_000,
    /** After this long without a rebuild, the next one counts as the first again. */
    private readonly quietMs = 30_000,
  ) {}

  /** Books the next rebuild; returns how long to wait from `now` before doing it (ms). */
  next(now: number): number {
    this.decay(now)
    const at = Math.max(now, this.lastAt + this.gap())
    this.lastAt = at
    this.attempts++
    return at - now
  }

  /** For callers that retry on their own schedule: true (and booked) if a rebuild may run now. */
  tryNow(now: number): boolean {
    this.decay(now)
    if (now < this.lastAt + this.gap()) return false
    this.lastAt = now
    this.attempts++
    return true
  }

  private decay(now: number): void {
    if (now - this.lastAt > this.quietMs) this.attempts = 0
  }

  private gap(): number {
    return this.attempts === 0 ? 0 : Math.min(this.maxMs, this.minMs * 2 ** (this.attempts - 1))
  }
}
