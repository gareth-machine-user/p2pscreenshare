// Continuous audio playout, run inside an AudioWorklet (see audio.ts).
//
// Decoded Opus chunks (~20 ms each) go into one ring buffer, and a single resampler reads it out
// at the output device's rate. Playing each chunk as its own AudioBufferSourceNode clicks: every
// buffer is resampled separately (44.1 kHz audio on a 48 kHz device has edge artefacts at each
// boundary), and drift is fixed by jumping. Here there are no chunk boundaries, drift is fixed by
// playing up to 1% fast or slow (inaudible), and the few real discontinuities (running dry, a
// skipped frame, a big re-sync) get a short fade instead of a hard cut.
//
// This class is stringified into the worklet's source, so it must stay self-contained: no imports,
// no module-level constants, nothing referenced from outside the class body.

export interface PlayoutStats {
  /** Times playback faded out and re-synced to the target timeline (drift past the limit). */
  resyncs: number
  /** Times the buffer ran dry while playing. */
  underruns: number
  /** Source samples discarded because they were already overdue. */
  droppedSamples: number
  /** Audio buffered ahead of the playhead, ms. */
  bufferedMs: number
  /** Smoothed timing error (positive: playing early), ms. */
  errorMs: number
}

export class Playout {
  outRate: number
  /** Output samples over which a fade runs (5 ms). */
  fadeLen: number
  /** Drift beyond which playback fades out and re-syncs instead of correcting gradually, s. */
  resyncS: number
  /** Largest playback speed change used to correct drift. */
  maxSkew: number
  /** Speed change per second of error (0.5: 20 ms early plays 1% slow). */
  skewGain: number

  rate = 0
  channels = 1
  ring: Float32Array[] = []
  cap = 0
  /** Absolute source-sample index of the next write. */
  writeIdx = 0
  /** Absolute (fractional) source-sample index of the playhead. */
  readPos = 0
  /** Chunk starts and their target play times (output-clock seconds), oldest first. */
  anchors: { idx: number; target: number }[] = []
  playing = false
  gain = 0
  gainTarget = 0
  errEma = 0
  stats: PlayoutStats

  constructor(outRate: number) {
    this.outRate = outRate
    this.fadeLen = Math.max(1, Math.round(outRate * 0.005))
    this.resyncS = 0.12
    this.maxSkew = 0.01
    this.skewGain = 0.5
    this.stats = { resyncs: 0, underruns: 0, droppedSamples: 0, bufferedMs: 0, errorMs: 0 }
  }

  reset(): void {
    this.rate = 0
    this.ring = []
    this.cap = 0
    this.writeIdx = 0
    this.readPos = 0
    this.anchors = []
    this.playing = false
    this.gain = 0
    this.gainTarget = 0
    this.errEma = 0
  }

  /** Queues one chunk of planar samples that should start playing at output-clock time `target`. */
  push(planes: Float32Array[], rate: number, target: number): void {
    const n = planes[0]?.length ?? 0
    if (!n) return
    if (rate !== this.rate || planes.length !== this.channels) {
      this.reset()
      this.rate = rate
      this.channels = planes.length
      this.cap = Math.ceil(rate * 4)
      this.ring = planes.map(() => new Float32Array(this.cap))
    }
    // Keep the ring from overflowing: drop the oldest audio (only after a long stall).
    if (this.writeIdx + n - this.readPos > this.cap) {
      this.readPos = this.writeIdx + n - this.cap
      this.playing = false
    }
    const last = this.anchors[this.anchors.length - 1]
    const expected = last ? last.target + (this.writeIdx - last.idx) / rate : target
    // A gap or an overlap in the timeline means the waveform jumps here: fade across the join.
    const join = last !== undefined && Math.abs(target - expected) > 0.015
    const fadeSrc = Math.max(1, Math.round(rate * 0.003))
    for (let ch = 0; ch < this.channels; ch++) {
      const ring = this.ring[ch]
      const src = planes[ch]
      for (let i = 0; i < n; i++) {
        const g = join && i < fadeSrc ? i / fadeSrc : 1
        ring[(this.writeIdx + i) % this.cap] = src[i] * g
      }
      if (join) {
        // Fade out the tail written before, as far as it hasn't been played yet.
        const from = Math.max(Math.ceil(this.readPos) + 2, this.writeIdx - fadeSrc)
        for (let j = from; j < this.writeIdx; j++) ring[j % this.cap] *= (this.writeIdx - j) / fadeSrc
      }
    }
    this.anchors.push({ idx: this.writeIdx, target })
    this.writeIdx += n
  }

  /** Output-clock time the source sample at `pos` should be heard. */
  targetOf(pos: number): number {
    const a = this.anchors
    let k = 0
    while (k + 1 < a.length && a[k + 1].idx <= pos) k++
    return a[k].target + (pos - a[k].idx) / this.rate
  }

  sample(ch: number, idx: number): number {
    const lo = Math.ceil(this.readPos) - 1
    const i = Math.min(Math.max(idx, lo), this.writeIdx - 1)
    return this.ring[ch][(i % this.cap + this.cap) % this.cap]
  }

  /** Fills `out` (planar, one block) starting at output-clock time `now`. */
  render(out: Float32Array[], now: number): void {
    const len = out[0]?.length ?? 0
    for (const o of out) o.fill(0)
    if (!len || !this.rate) return
    // Forget anchors the playhead has passed (keeping the one it is in).
    while (this.anchors.length > 1 && this.anchors[1].idx <= this.readPos) this.anchors.shift()

    if (!this.playing) {
      if (this.writeIdx - this.readPos < 4 || !this.anchors.length) return
      let target = this.targetOf(this.readPos)
      // Already overdue: skip ahead to what should be playing now.
      if (target < now) {
        const skip = Math.min((now - target) * this.rate, this.writeIdx - this.readPos)
        this.readPos += skip
        this.stats.droppedSamples += Math.round(skip)
        while (this.anchors.length > 1 && this.anchors[1].idx <= this.readPos) this.anchors.shift()
        if (this.writeIdx - this.readPos < 4) return
        target = this.targetOf(this.readPos)
      }
      const wait = Math.round((target - now) * this.outRate)
      if (wait >= len) return
      this.playing = true
      this.gain = 0
      this.gainTarget = 1
      this.errEma = 0
      this.renderFrom(out, Math.max(0, wait), len, now)
      return
    }
    this.renderFrom(out, 0, len, now)
  }

  renderFrom(out: Float32Array[], from: number, len: number, now: number): void {
    const err = this.targetOf(this.readPos) - (now + from / this.outRate)
    this.errEma += (err - this.errEma) * 0.1
    if (Math.abs(err) > this.resyncS && this.gainTarget > 0) {
      this.stats.resyncs++
      this.gainTarget = 0
    }
    const skew = Math.max(-this.maxSkew, Math.min(this.maxSkew, this.skewGain * this.errEma))
    const step = (this.rate / this.outRate) * (1 - skew)
    const fadeStep = 1 / this.fadeLen
    const outCh = out.length
    for (let n = from; n < len; n++) {
      const avail = this.writeIdx - this.readPos
      // About to run dry: fade out over what is left rather than stopping dead.
      if (avail / step <= this.fadeLen + 2 && this.gainTarget > 0) {
        this.stats.underruns++
        this.gainTarget = 0
      }
      if (avail < 2) {
        this.playing = false
        this.gain = 0
        break
      }
      const i = Math.floor(this.readPos)
      const t = this.readPos - i
      for (let c = 0; c < outCh; c++) {
        const ch = c < this.channels ? c : this.channels - 1
        // Catmull-Rom interpolation between samples i and i+1.
        const p0 = this.sample(ch, i - 1)
        const p1 = this.sample(ch, i)
        const p2 = this.sample(ch, i + 1)
        const p3 = this.sample(ch, i + 2)
        const v = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
        out[c][n] = v * this.gain
      }
      this.readPos += step
      if (this.gain < this.gainTarget) this.gain = Math.min(this.gainTarget, this.gain + fadeStep)
      else if (this.gain > this.gainTarget) this.gain = Math.max(this.gainTarget, this.gain - fadeStep)
      if (this.gain === 0 && this.gainTarget === 0) {
        // Faded out (re-sync or running dry): start again from the target timeline.
        this.playing = false
        break
      }
    }
    this.stats.bufferedMs = Math.max(0, ((this.writeIdx - this.readPos) / this.rate) * 1000)
    this.stats.errorMs = this.errEma * 1000
  }
}
