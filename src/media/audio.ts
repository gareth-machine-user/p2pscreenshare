import { wallClock } from '../net/clock'
import { NO_REF } from '../proto/framing'
import type { StreamInfo } from '../proto/messages'
import type { EncodedFrame } from './packetizer'

type AudioInfo = NonNullable<StreamInfo['audio']>

/** Minimum time between AudioDecoder rebuilds after errors. */
const REBUILD_INTERVAL_MS = 1000

/** Encodes an audio track to Opus (Chromium: needs MediaStreamTrackProcessor). */
export class AudioPipeline {
  onFrame: (f: EncodedFrame) => void = () => {}
  info: AudioInfo | null = null
  private encoder: AudioEncoder | null = null
  private seq = 0
  private stopped = false
  private reader: ReadableStreamDefaultReader<AudioData> | null = null

  constructor(private track: MediaStreamTrack) {}

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
          captureTime: wallClock(),
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

/** Decodes Opus frames and schedules them on the shared playout timeline. */
export class AudioPlayer {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  /** Every stream starts muted; unmuting needs a user gesture (autoplay policy). */
  muted = true
  private decoder: AudioDecoder | null = null
  private configured = ''
  private info: AudioInfo | null = null
  private lastBuildAt = -Infinity
  private renderAtByTs = new Map<number, number>()
  private lastSeq = -1

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
    this.renderAtByTs.clear()
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
    if (f.seq <= this.lastSeq) return
    this.lastSeq = f.seq
    if ((!this.decoder || this.decoder.state === 'closed') && !this.build()) return
    const ts = Math.round(f.captureTime * 1000)
    this.renderAtByTs.set(ts, renderAt)
    if (this.renderAtByTs.size > 300) this.renderAtByTs.clear()
    try {
      this.decoder!.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: f.data }))
    } catch (err) {
      console.warn('audio decode error', err)
    }
  }

  private play(data: AudioData): void {
    const ctx = this.ctx
    const renderAt = this.renderAtByTs.get(data.timestamp)
    this.renderAtByTs.delete(data.timestamp)
    if (!ctx || renderAt === undefined) {
      data.close()
      return
    }
    const when = ctx.currentTime + (renderAt - wallClock()) / 1000
    if (when < ctx.currentTime) {
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
    src.start(when)
  }

  close(): void {
    this.info = null
    this.closeDecoder()
    void this.ctx?.close().catch(() => {})
  }
}
