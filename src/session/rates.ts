// Turns cumulative counters into per-second rates over a sampling window.

export class RateWindow<T extends { [K in keyof T]: number }> {
  private last: { at: number; values: T } | null = null

  /** Rates per second since the previous call (zeros on the first). */
  sample(values: T, now = performance.now()): T {
    const prev = this.last
    this.last = { at: now, values: { ...values } }
    const out = {} as T
    const dt = prev ? (now - prev.at) / 1000 : 0
    for (const k of Object.keys(values) as (keyof T)[]) {
      out[k] = (prev && dt > 0 ? Math.max(0, (values[k] - prev.values[k]) / dt) : 0) as T[keyof T]
    }
    return out
  }
}

export const round1 = (x: number) => Math.round(x * 10) / 10
