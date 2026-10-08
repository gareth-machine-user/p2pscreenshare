import { wallClock } from '../net/clock'
import { NO_REF } from '../proto/framing'
import type { StreamInfo } from '../proto/messages'
import type { EncodedFrame } from './packetizer'
import { Playout, type PlayoutStats } from './playout'
import { closeCodec } from './codecs'
import { RebuildBackoff } from './rebuildBackoff'
import { AUDIO_FRAME_MS, AUDIO_KBPS } from '../session/capacity'

type AudioInfo = NonNullable<StreamInfo['audio']>

/** Most encoded audio frames held for decoding (about 5 s). */
const MAX_PENDING = Math.ceil(5000 / AUDIO_FRAME_MS)

/** AudioWorklet module: the Playout class (stringified) behind a processor that feeds it. */
const WORKLET_SRC = `
const Playout = (${Playout.toString()});
class P2PPlayout extends AudioWorkletProcessor {
  constructor() {
    super()
    this.p = new Playout(sampleRate)
    this.blocks = 0
    this.port.onmessage = (e) => {
      const m = e.data
      if (m.reset) this.p.reset()
      else this.p.push(m.planes, m.rate, m.target)
    }
  }
  process(_inputs, outputs) {
    this.p.render(outputs[0], currentTime)
    if (++this.blocks % 200 === 0) this.port.postMessage(this.p.stats)
    return true
  }
}
registerProcessor('p2p-playout', P2PPlayout)
`

/** Copies decoded audio out as one float32 array per channel. */
function planesOf(data: AudioData): Float32Array<ArrayBuffer>[] {
  return Array.from({ length: data.numberOfChannels }, (_, ch) => {
    const plane = new Float32Array(data.numberOfFrames)
    data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' })
    return plane
  })
}

/** An Opus config for audio at this rate and channel count; throws if Opus isn't supported. */
async function opusConfig(sampleRate: number, numberOfChannels: number): Promise<AudioEncoderConfig> {
  // Tuned for music and game audio rather than speech. `application` and `signal` are newer than
  // the DOM typings; browsers that don't know them ignore them.
  const opus = { application: 'audio', signal: 'music', complexity: 10, frameDuration: AUDIO_FRAME_MS * 1000 } as OpusEncoderConfig
  const base: AudioEncoderConfig = { codec: 'opus', sampleRate, numberOfChannels, bitrate: AUDIO_KBPS * 1000 }
  for (const config of [{ ...base, opus }, base]) {
    if ((await AudioEncoder.isConfigSupported(config)).supported) return config
  }
  throw new Error('Opus encoding not supported')
}

/** Encodes an audio track to Opus (Chromium: needs MediaStreamTrackProcessor). */
export class AudioPipeline {
  onFrame: (f: EncodedFrame) => void = () => {}
  info: AudioInfo | null = null
  private encoder: AudioEncoder | null = null
  private config: AudioEncoderConfig | null = null
  /** Paces rebuilds of an encoder that errored (an error closes it). */
  private rebuilds = new RebuildBackoff()
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
    if (this.stopped) return
    this.reader = new MediaStreamTrackProcessor<AudioData>({ track: this.track }).readable.getReader()
    try {
      while (!this.stopped) {
        const { value, done } = await this.reader.read()
        if (done || !value) break
        try {
          if (this.stopped) break
          // Configured from the audio itself: an encoder whose sample rate or channel count differs
          // from its input fails on every frame, and track settings may not report them (the
          // mixer's track runs at its AudioContext's rate, often 44.1 kHz).
          if (!this.config) {
            this.config = await opusConfig(value.sampleRate, value.numberOfChannels)
            if (this.stopped) break
            this.info = { codec: 'opus', sampleRate: this.config.sampleRate, numberOfChannels: this.config.numberOfChannels }
          }
          if (!this.encoder && this.rebuilds.tryNow(wallClock())) this.buildEncoder()
          if (this.encoder?.state === 'configured') this.encoder.encode(value)
        } catch (err) {
          if (!this.config) throw err
          console.error('audio encode failed', err)
        } finally {
          value.close()
        }
      }
    } finally {
      if (this.stopped || !this.config) void this.reader.cancel().catch(() => {})
    }
  }

  /** (Re)creates the encoder. An error closes it; the next frame then rebuilds it (paced). */
  private buildEncoder(): void {
    const encoder = new AudioEncoder({
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
          // From the audio's own timestamps (regular frame spacing), anchored to the wall clock
          // once: the encoder's output timing is bursty.
          captureTime: this.captureTimeOf(chunk.timestamp),
          data,
        })
      },
      error: (e) => {
        console.error('AudioEncoder error; rebuilding', e)
        if (this.encoder === encoder) this.encoder = null
      },
    })
    this.encoder = encoder
    try {
      encoder.configure(this.config!)
    } catch (err) {
      console.error('AudioEncoder configure failed', err)
      this.encoder = null
      closeCodec(encoder)
    }
  }

  stop(): void {
    this.stopped = true
    void this.reader?.cancel().catch(() => {})
    closeCodec(this.encoder)
  }
}

/**
 * Decodes Opus frames and plays them on the shared playout timeline.
 *
 * Audio frames are erasure coded across the stripes, which take unordered channels and different
 * relay paths, so they complete out of order. They are kept in a small jitter buffer and decoded
 * in sequence (Opus is stateful); a missing frame is skipped only when the next one is due. Decoded chunks go to an
 * AudioWorklet that plays them as one continuous, resampled stream (see playout.ts). Without
 * AudioWorklet, chunks are scheduled back to back as separate buffers, which can click.
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
  /** The playout worklet, once loaded; null while loading or when unsupported (fallback). */
  private node: AudioWorkletNode | null = null
  /** 'loading' drops decoded audio until the worklet is ready. */
  mode: 'loading' | 'worklet' | 'direct' = 'loading'
  stats: { played: number; late: number; skipped: number } & Pick<PlayoutStats, 'resyncs' | 'underruns'> & Partial<PlayoutStats> = {
    played: 0,
    late: 0,
    skipped: 0,
    resyncs: 0,
    underruns: 0,
  }
  private info: AudioInfo | null = null
  /** Paces decoder rebuilds after errors: at most one a second. */
  private rebuilds = new RebuildBackoff(1000, 1000)

  /** Must be called from a user gesture (autoplay policy). */
  enable(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' })
      this.gain = this.ctx.createGain()
      this.gain.connect(this.ctx.destination)
      void this.loadWorklet(this.ctx)
      this.ctx.addEventListener('statechange', this.onStateChange)
    }
    if (this.ctx.state !== 'closed') void this.ctx.resume().catch(() => {})
  }

  /**
   * The browser can suspend a running context (an output device change, the OS sleeping) or
   * interrupt it (Safari: a call, another app taking audio). While suspended, push() drops all
   * audio, so an unmuted stream would stay silent: resume it. Without a user gesture the resume
   * may be refused; the next unmute retries.
   */
  private onStateChange = (): void => {
    const ctx = this.ctx
    const state = ctx?.state as string | undefined
    if (!ctx || this.muted || (state !== 'suspended' && state !== 'interrupted')) return
    void ctx.resume().catch(() => {})
  }

  private async loadWorklet(ctx: AudioContext): Promise<void> {
    if (!ctx.audioWorklet) {
      this.mode = 'direct'
      return
    }
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
      if (this.ctx !== ctx) return
      const node = new AudioWorkletNode(ctx, 'p2p-playout', { numberOfInputs: 0, outputChannelCount: [2] })
      node.port.onmessage = (e: MessageEvent<PlayoutStats>) => Object.assign(this.stats, e.data)
      node.connect(this.gain ?? ctx.destination)
      this.node = node
      this.mode = 'worklet'
    } catch (err) {
      console.warn('audio worklet unavailable; scheduling buffers directly', err)
      this.mode = 'direct'
    } finally {
      URL.revokeObjectURL(url)
    }
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
    this.rebuilds = new RebuildBackoff(1000, 1000)
    this.pending.clear()
    this.nextSeq = null
    this.node?.port.postMessage({ reset: true })
    this.build()
  }

  /** (Re)creates the decoder; a decoder error closes it, so it's rebuilt on the next frame. */
  private build(): boolean {
    const info = this.info
    if (!info) return false
    if (!this.rebuilds.tryNow(wallClock())) return false
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
    closeCodec(this.decoder)
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
      if (this.pending.get(later)!.renderAt - wallClock() > AUDIO_FRAME_MS) return
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
    if (this.mode !== 'direct') {
      this.playWorklet(data, target, now)
      return
    }
    const duration = data.numberOfFrames / data.sampleRate
    // Back to back with what is already scheduled, unless that drifted far from the target.
    let start = this.nextTime
    if (this.nextTime < now || Math.abs(target - this.nextTime) > Playout.RESYNC_S) {
      if (this.nextTime > 0) this.stats.resyncs++
      start = Math.max(target, now + 0.01)
    }
    if (start + duration < now) {
      this.stats.late++
      data.close()
      return
    }
    const buf = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate)
    planesOf(data).forEach((plane, ch) => buf.copyToChannel(plane, ch))
    data.close()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.gain ?? ctx.destination)
    src.start(start)
    this.nextTime = start + duration
    this.stats.played++
  }

  private playWorklet(data: AudioData, target: number, now: number): void {
    const node = this.node
    if (!node) {
      data.close()
      return
    }
    const planes = planesOf(data)
    const rate = data.sampleRate
    if (target + data.numberOfFrames / rate < now) this.stats.late++
    data.close()
    node.port.postMessage({ planes, rate, target }, planes.map((p) => p.buffer))
    this.stats.played++
  }

  close(): void {
    this.info = null
    this.node?.disconnect()
    this.node = null
    this.closeDecoder()
    this.ctx?.removeEventListener('statechange', this.onStateChange)
    void this.ctx?.close().catch(() => {})
  }
}
