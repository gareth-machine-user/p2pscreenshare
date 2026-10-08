import { wallClock } from '../net/clock'
import { sleep } from '../net/ticker'
import { toBase64, type StreamInfo } from '../proto/messages'
import { frameReader } from './capture'
import { closeCodec } from './codecs'
import { LayerRefs } from './layerRefs'
import type { EncodedFrame } from './packetizer'
import { bitsPerPixel, HIGH_BPP } from './quality'

const IDLE_REFRESH_MS = 400
const ERROR_RETRY_MS = 1000

export interface VideoEncoderOptions {
  bitrateKbps: number
  fps: number
  keyframeIntervalMs: number
}

interface Candidate {
  codec: string
  scalabilityMode?: string
  avc?: AvcEncoderConfig
  hardwareAcceleration?: HardwareAcceleration
}

/**
 * At high bitrates per pixel: a hardware H.264 High-profile encoder (level 5.2: up to 4K60). In
 * real-time mode, software VP9 stops turning extra bits into quality well before "near-lossless";
 * GPU encoders keep up at 1080p60 and beyond. Temporal layers are required: without them a frame
 * dropped under congestion would break decoding until the next keyframe. Chrome treats
 * prefer-hardware as hardware only, so machines without such an encoder fall through to VP9.
 */
const HIGH_BITRATE_CANDIDATES: Candidate[] = [
  { codec: 'avc1.640034', scalabilityMode: 'L1T3', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' },
  { codec: 'avc1.640034', scalabilityMode: 'L1T2', avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' },
]

// Prefer codecs with temporal scalability (lets relays shed frame rate under pressure).
const CANDIDATES: Candidate[] = [
  { codec: 'vp09.00.10.08', scalabilityMode: 'L1T3' },
  { codec: 'av01.0.04M.08', scalabilityMode: 'L1T3' },
  { codec: 'vp8', scalabilityMode: 'L1T3' },
  { codec: 'vp09.00.10.08' },
  { codec: 'avc1.42001f', avc: { format: 'annexb' } },
]

async function pickConfig(width: number, height: number, o: VideoEncoderOptions): Promise<VideoEncoderConfig> {
  const high = bitsPerPixel(o.bitrateKbps, width, height, o.fps) >= HIGH_BPP
  const candidates = high ? [...HIGH_BITRATE_CANDIDATES, ...CANDIDATES] : CANDIDATES
  // Constant bitrate first: fast motion then costs quality instead of making frames several times
  // the average size, which would overflow the uplinks the relay trees were planned for.
  for (const bitrateMode of ['constant', 'variable'] as const) {
    for (const c of candidates) {
      const config: VideoEncoderConfig = {
        codec: c.codec,
        width,
        height,
        bitrate: o.bitrateKbps * 1000,
        framerate: o.fps,
        latencyMode: 'realtime',
        bitrateMode,
        ...(c.scalabilityMode ? { scalabilityMode: c.scalabilityMode } : {}),
        ...(c.avc ? { avc: c.avc } : {}),
        ...(c.hardwareAcceleration ? { hardwareAcceleration: c.hardwareAcceleration } : {}),
      }
      try {
        const res = await VideoEncoder.isConfigSupported(config)
        if (res.supported) return res.config ?? config
      } catch {
        // try next
      }
    }
  }
  throw new Error('No supported WebCodecs video encoder configuration')
}

/**
 * The codec string viewers configure their decoder with. Annex B H.264 carries its parameter sets
 * in band, and a hardware encoder may report a different level after a bitrate change: announcing
 * that would make every viewer rebuild its decoder and wait for a keyframe. The configured string
 * (High profile, level 5.2) decodes anything the encoder produces.
 */
function streamCodec(dc: VideoDecoderConfig, config: VideoEncoderConfig): string {
  return dc.codec.startsWith('avc1') && !dc.description && config.codec.startsWith('avc1') ? config.codec : dc.codec
}

/**
 * Captures frames from a track and encodes them once (WebCodecs). Emits EncodedFrames with
 * temporal-layer and reference metadata, and StreamInfo whenever the decoder config changes.
 */
export class VideoPipeline {
  onFrame: (f: EncodedFrame) => void = () => {}
  onStreamInfo: (info: StreamInfo) => void = () => {}
  /** Every captured (or idle-refreshed) frame, before encoding; valid only during the call. */
  onRawFrame: (frame: VideoFrame) => void = () => {}

  private encoder: VideoEncoder | null = null
  private config: VideoEncoderConfig | null = null
  private epoch = 0
  /** Frame numbering and references (L1Tn). */
  private refs = new LayerRefs()
  private lastKeyAt = -Infinity
  private keyRequested = true
  /** Set by setTarget: the next frame picks the codec and config afresh. */
  private repick = false
  private stopped = false
  private reader: ReturnType<typeof frameReader> | null = null
  private captureTimes = new Map<number, number>()
  private lastInfoKey = ''
  /** When the encoder last failed (it is rebuilt after ERROR_RETRY_MS). */
  private failedAt = -Infinity
  /** Counters (cumulative): frames captured, dropped because the encoder was behind, encoded. */
  framesIn = 0
  framesDropped = 0
  framesEncoded = 0
  keyframes = 0
  bytesOut = 0
  /** Smoothed time from handing a frame to the encoder to getting its chunk (ms). */
  encodeMs = 0
  /** Largest encoded frame since the last read (see takeMaxFrameBytes). */
  private maxFrameBytes = 0

  takeMaxFrameBytes(): number {
    const m = this.maxFrameBytes
    this.maxFrameBytes = 0
    return m
  }

  constructor(
    /** The capture track, or null for a pipeline fed with encodeExternal (the preview). */
    private track: MediaStreamTrack | null,
    private opts: VideoEncoderOptions,
  ) {}

  /** Encodes a frame produced elsewhere (closes it). */
  async encodeExternal(frame: VideoFrame): Promise<void> {
    if (this.stopped) {
      frame.close()
      return
    }
    try {
      await this.encodeFrame(frame)
    } catch (err) {
      console.error('encode failed', err)
    } finally {
      frame.close()
    }
  }

  get codec(): string | null {
    return this.config?.codec ?? null
  }

  requestKeyframe(): void {
    this.keyRequested = true
  }

  /**
   * Changes the bitrate in place, without a keyframe: the decoder needs none, and at high bitrates
   * (a GPU H.264 keyframe at 60 fps) the burst would overflow the relay queues, break viewers' decode
   * chains and set off the keyframe requests and further bitrate cuts that cause more of the same.
   */
  setBitrate(kbps: number): void {
    this.opts.bitrateKbps = kbps
    if (this.encoder && this.config) {
      this.config = { ...this.config, bitrate: kbps * 1000 }
      if (this.encoder.state !== 'configured') return
      this.encoder.configure(this.config)
    }
  }

  /**
   * A deliberate quality change (bitrate and frame rate): the next frame rebuilds the encoder,
   * choosing the codec again for the new bits per pixel. Congestion control uses setBitrate
   * instead, which keeps the codec, so it never flips between codecs.
   */
  setTarget(kbps: number, fps: number): void {
    if (kbps === this.opts.bitrateKbps && fps === this.opts.fps) return
    this.opts.bitrateKbps = kbps
    this.opts.fps = fps
    this.repick = true
  }

  /**
   * Captures from another track from now on (e.g. the other camera), with no new channel: the
   * encoder rebuilds only if the frame size changes, and the next frame is a keyframe either way.
   */
  replaceTrack(track: MediaStreamTrack): void {
    if (this.stopped) return
    const old = this.reader
    this.track = track
    this.reader = frameReader(track, () => this.opts.fps)
    this.keyRequested = true
    // Ends the old reader (if its track hasn't already): start() moves on to the new one.
    old?.stop()
  }

  async start(): Promise<void> {
    if (!this.track) return
    this.reader = frameReader(this.track, () => this.opts.fps)
    // Screen capture only delivers frames when pixels change. Re-encode the last frame while idle so
    // stripes stay alive (silence means "dead parent" to viewers) and keyframes keep flowing.
    let last: VideoFrame | null = null
    /** When `last` was captured (performance.now), to stamp its re-encodes on the capture's clock. */
    let lastAt = 0
    let reader = this.reader
    let pending = reader.next()
    for (;;) {
      const res = await Promise.race([
        pending.then((f) => ({ f })),
        // Worker-driven: a presenter's backgrounded tab keeps refreshing (timers there are throttled).
        sleep(IDLE_REFRESH_MS).then(() => null),
      ])
      if (this.stopped) {
        if (res?.f) res.f.close()
        break
      }
      if (this.reader !== reader) {
        // The track was replaced: drop what the old reader had in flight, read the new one.
        if (res?.f) res.f.close()
        else if (!res) void pending.then((f) => f?.close())
        reader = this.reader!
        pending = reader.next()
        continue
      }
      let frame: VideoFrame
      if (res === null) {
        if (!last) continue
        // The capture's timestamps aren't on performance.now()'s clock: a re-encode stamped with
        // that would make timestamps jump when real frames resume (encoders want them monotonic).
        frame = new VideoFrame(last, { timestamp: last.timestamp + Math.round((performance.now() - lastAt) * 1000) })
      } else {
        if (!res.f) {
          // The track ended. Either a new one is on its way (replaceTrack, e.g. between cameras),
          // or the stream is stopping: meanwhile keep re-sending the last frame.
          pending = new Promise(() => {})
          continue
        }
        pending = reader.next()
        frame = res.f
        last?.close()
        last = frame.clone()
        lastAt = performance.now()
      }
      this.framesIn++
      try {
        this.onRawFrame(frame)
        await this.encodeFrame(frame)
      } catch (err) {
        console.error('encode failed', err)
      } finally {
        frame.close()
      }
    }
    last?.close()
  }

  private async encodeFrame(frame: VideoFrame): Promise<void> {
    const width = frame.displayWidth & ~1
    const height = frame.displayHeight & ~1
    if (this.repick || !this.encoder || !this.config || this.config.width !== width || this.config.height !== height) {
      // After an encoder error, wait a little before building a new one (avoids a hot loop).
      if (!this.encoder && wallClock() - this.failedAt < ERROR_RETRY_MS) {
        this.framesDropped++
        return
      }
      await this.reconfigure(width, height)
    }
    const enc = this.encoder
    if (this.stopped || !enc || enc.state !== 'configured') return
    if (enc.encodeQueueSize > 2) {
      this.framesDropped++
      return
    }
    const now = wallClock()
    const key = this.keyRequested || now - this.lastKeyAt >= this.opts.keyframeIntervalMs
    if (key) {
      this.keyRequested = false
      this.lastKeyAt = now
    }
    this.captureTimes.set(frame.timestamp, now)
    enc.encode(frame, { keyFrame: key })
  }

  private async reconfigure(width: number, height: number): Promise<void> {
    const old = this.encoder
    this.encoder = null
    if (old) {
      try {
        await old.flush()
      } catch {
        // Flushing fails on an encoder that errored or closed; its pending output is lost anyway.
      }
      closeCodec(old)
    }
    this.repick = false
    let config: VideoEncoderConfig
    try {
      config = await pickConfig(width, height, this.opts)
    } catch (err) {
      // Wait before probing again: each attempt runs a dozen isConfigSupported checks.
      this.failedAt = wallClock()
      throw err
    }
    if (this.stopped) return
    this.config = config
    this.epoch = (this.epoch + 1) & 0xffff
    this.keyRequested = true
    const encoder = new VideoEncoder({
      output: (chunk, meta) => this.handleChunk(chunk, meta),
      error: (e) => {
        // An error closes the encoder: drop it so the next frame builds a new one (new epoch,
        // starting with a keyframe).
        console.error('VideoEncoder error; rebuilding', e)
        if (this.encoder === encoder) {
          this.encoder = null
          this.failedAt = wallClock()
        }
      },
    })
    this.encoder = encoder
    try {
      encoder.configure(config)
    } catch (err) {
      this.encoder = null
      this.failedAt = wallClock()
      closeCodec(encoder)
      throw err
    }
  }

  private handleChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    const captureTime = this.captureTimes.get(chunk.timestamp) ?? wallClock()
    this.captureTimes.delete(chunk.timestamp)
    const took = wallClock() - captureTime
    this.encodeMs = this.framesEncoded === 0 ? took : this.encodeMs * 0.9 + took * 0.1
    this.framesEncoded++
    if (chunk.type === 'key') this.keyframes++
    this.bytesOut += chunk.byteLength
    this.maxFrameBytes = Math.max(this.maxFrameBytes, chunk.byteLength)
    if (this.captureTimes.size > 120) this.captureTimes.clear()

    if (meta?.decoderConfig) {
      const dc = meta.decoderConfig
      const info: StreamInfo = {
        epoch: this.epoch,
        codec: streamCodec(dc, this.config!),
        codedWidth: dc.codedWidth ?? this.config!.width,
        codedHeight: dc.codedHeight ?? this.config!.height,
        description: dc.description ? toBase64(toBytes(dc.description)) : undefined,
      }
      const k = JSON.stringify(info)
      if (k !== this.lastInfoKey) {
        this.lastInfoKey = k
        this.onStreamInfo(info)
      }
    }

    const key = chunk.type === 'key'
    const refs = this.refs.next(key, meta?.svc?.temporalLayerId ?? 0)
    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    this.onFrame({ epoch: this.epoch, ...refs, key, audio: false, captureTime, data })
  }

  stop(): void {
    this.stopped = true
    this.reader?.stop()
    closeCodec(this.encoder)
  }
}

function toBytes(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0))
  const view = src as ArrayBufferView
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}
