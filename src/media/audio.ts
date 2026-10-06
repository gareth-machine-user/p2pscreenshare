import { wallClock } from '../net/clock'
import { NO_REF } from '../proto/framing'
import type { StreamInfo } from '../proto/messages'
import type { EncodedFrame } from './packetizer'

type AudioInfo = NonNullable<StreamInfo['audio']>

/** Minimum time between AudioDecoder rebuilds after errors. */
const REBUILD_INTERVAL_MS = 1000
/** Most encoded audio frames held for decoding (about 5 s of 20 ms frames). */
const MAX_PENDING = 250

/** Encodes an audio track to Opus (Chromium: needs MediaStreamTrackProcessor). */
export class AudioPipeline {
  onFrame: (f: EncodedFrame) => void = () => {}
  info: AudioInfo | null = null
  private encoder: AudioEncoder | null = null
  private seq = 0
  private stopped = false
  private reader: ReadableStreamDefaultReader<AudioData> | null = null

  private tsOffsetMs: number | null = null

  constructor(private track: MediaStreamTrack) {}

  /** Wall-clock capture time of a chunk, from its media timestamp (µs). */
  private captureTimeOf(timestampUs: number): number {
    const ms = timestampUs / 1000
    const now = wallClock()
    // Re-anchor if the media clock and the wall clock drift apart by more than 200 ms.
    if (this.tsOffsetMs === null || Math.abs(ms + this.tsOffsetMs - now) > 200) this.tsOffsetMs = now - ms
    return ms + this.tsOffsetMs
  }

  static supported(): boolean {
    return typeof AudioEncoder !== 'undefined' && typeof MediaStreamTrackProcessor !== 'undefined'
  }

  async start(): Promise<void> {
    const settings = this.track.getSettings()
    const sampleRate = settings.sampleRate ?? 48000
    const numberOfChannels = Math.min(2, settings.channelCount ?? 2)
    const config: AudioEncoderConfig = { codec: 'opus', sampleRate, numberOfChannels, bitrate: 64_000 }
    const support = await AudioEncoder.isConfigSupported(config)
    if (!support.supported) throw new Error('Opus encoding not supported')
    this.info = { codec: 'opus', sampleRate, numberOfChannels }
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        this.onFrame({
          epoch: 0,
          seq: this.seq++ >>> 0,
          gopId: 0,
          refSeq: NO_REF,
          key: true,
          layer: 0,
          audio: true,
          // From the audio's own timestamps (regular 20 ms spacing), anchored to the wall clock
          // once: the encoder's output timing is bursty.
          captureTime: this.captureTimeOf(chunk.timestamp),
          data,
        })
      },
      error: (e) => console.error('AudioEncoder error', e),
    })
    this.encoder.configure(config)
    this.reader = new MediaStreamTrackProcessor<AudioData>({ track: this.track }).readable.getReader()
    while (!this.stopped) {
      const { value, done } = await this.reader.read()
      if (done || !value) break
      if (this.encoder.state === 'configured') this.encoder.encode(value)
      value.close()
    }
  }

  stop(): void {
    this.stopped = true
    void this.reader?.cancel().catch(() => {})
    try {
      this.encoder?.close()
    } catch {
      // Already closed (e.g. after an encoder error): nothing left to release.
    }
  }
}

/**
 * Decodes Opus frames and plays them on the shared playout timeline.
 *
 * Audio frames travel on every stripe over unordered channels and different relay paths, so they
 * arrive out of order. They are kept in a small jitter buffer and decoded in sequence (Opus is
 * stateful); a missing frame is skipped only when the next one is due. Decoded chunks are played
 * back to back, each starting where the previous one ended, so jitter in the target times doesn't
 * leave clicks or gaps; playback re-syncs only if it drifts from the target by more than RESYNC_S.
 */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  /** Every stream starts muted; unmuting needs a user gesture (autoplay policy). */
  muted = true
  private decoder: AudioDecoder | null = null
  private configured = ''
  /** Encoded frames waiting to be decoded, by sequence number. */
  private pending = new Map<number, { f: EncodedFrame; renderAt: number }>()
  private nextSeq: number | null = null
  /** Target play times of frames handed to the decoder, in decode order. */
  private decoding: number[] = []
  /** Audio-context time where the scheduled audio ends. */
  private nextTime = 0
  stats = { played: 0, late: 0, skipped: 0, resyncs: 0 }
  private info: AudioInfo | null = null
  private lastBuildAt = -Infinity

  /** Must be called from a user gesture (autoplay policy). */
  enable(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
    }
    void this.ctx.resume()
  }

  /** Unmuting must happen in a user gesture. Muting keeps decoding, so unmuting is instant. */
  setMuted(muted: boolean): void {
    if (!muted) this.enable()
    this.muted = muted
    if (this.gain) this.gain.gain.value = muted ? 0 : 1
  }

  get enabled(): boolean {
    return this.ctx?.state === 'running'
  }

  configure(info: AudioInfo): void {
    const key = JSON.stringify(info)
    if (key === this.configured || typeof AudioDecoder === 'undefined') return
    this.configured = key
    this.info = info
    this.lastBuildAt = -Infinity
    this.pending.clear()
    this.nextSeq = null
    this.build()
  }

  /** (Re)creates the decoder; a decoder error closes it, so it's rebuilt on the next frame. */
  private build(): boolean {
    const info = this.info
    if (!info) return false
    const now = wallClock()
    if (now - this.lastBuildAt < REBUILD_INTERVAL_MS) return false
    this.lastBuildAt = now
    this.closeDecoder()
    // Frames still inside a failed decoder never come out: their play times must go too, or every
    // later chunk would be scheduled against the wrong one.
    this.decoding = []
    const decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: (e) => {
        console.warn('AudioDecoder error; rebuilding', e)
        if (this.decoder === decoder) this.decoder = null
      },
    })
    this.decoder = decoder
    try {
      decoder.configure({ codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.numberOfChannels })
    } catch (err) {
      console.warn('AudioDecoder configure failed', err)
      this.closeDecoder()
      return false
    }
    return true
  }

  private closeDecoder(): void {
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    } catch {
      // Closing is best effort: the decoder is being discarded either way.
    }
    this.decoder = null
  }

  /** `renderAt` is the local wall-clock time this frame should be heard. */
  push(f: EncodedFrame, renderAt: number | null): void {
    if (!this.info || !this.enabled || renderAt === null) return
    // Already decoded (or skipped): a duplicate or a straggler.
    if (this.nextSeq !== null && f.seq < this.nextSeq) return
    if (this.pending.has(f.seq)) return
    // Bounded while a failed decoder waits to be rebuilt.
    if (this.pending.size >= MAX_PENDING) {
      this.pending.clear()
      this.nextSeq = null
    }
    this.pending.set(f.seq, { f, renderAt })
    if (!this.decoder || this.decoder.state === 'closed') this.build()
    this.pump()
  }

  /** Decodes in sequence order; skips a missing frame once a later one is about due. */
  pump(): void {
    const decoder = this.decoder
    if (!decoder || decoder.state !== 'configured') return
    for (;;) {
      if (this.nextSeq === null) {
        if (!this.pending.size) return
        this.nextSeq = Math.min(...this.pending.keys())
      }
      const item = this.pending.get(this.nextSeq)
      if (item) {
        this.pending.delete(this.nextSeq)
        this.nextSeq++
        this.decoding.push(item.renderAt)
        try {
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(item.f.captureTime * 1000), data: item.f.data }))
        } catch (err) {
          this.decoding.pop()
          console.warn('audio decode error', err)
        }
        continue
      }
      // nextSeq is missing: wait unless a later frame is due within a frame's time.
      if (!this.pending.size) return
      const later = Math.min(...this.pending.keys())
      if (this.pending.get(later)!.renderAt - wallClock() > 20) return
      this.stats.skipped += later - this.nextSeq
      this.nextSeq = later
    }
  }

  private play(data: AudioData): void {
    const ctx = this.ctx
    const renderAt = this.decoding.shift()
    if (!ctx || renderAt === undefined) {
      data.close()
      return
    }
    const now = ctx.currentTime
    const target = now + (renderAt - wallClock()) / 1000
    const duration = data.numberOfFrames / data.sampleRate
    // Back to back with what is already scheduled, unless that drifted far from the target.
    let start = this.nextTime
    if (this.nextTime < now || Math.abs(target - this.nextTime) > RESYNC_S) {
      if (this.nextTime > 0) this.stats.resyncs++
      start = Math.max(target, now + 0.01)
    }
    if (start + duration < now) {
      this.stats.late++
      data.close()
      return
    }
    const buf = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate)
    for (let ch = 0; ch < data.numberOfChannels; ch++) {
      const plane = new Float32Array(data.numberOfFrames)
      data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
      buf.copyToChannel(plane, ch)
    }
    data.close()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.gain ?? ctx.destination)
    src.start(start)
    this.nextTime = start + duration
    this.stats.played++
  }

  close(): void {
    this.info = null
    this.closeDecoder()
    void this.ctx?.close().catch(() => {})
  }
}

/** Playback re-syncs to the jitter buffer's target when it drifts further than this (s). */
const RESYNC_S = 0.12
