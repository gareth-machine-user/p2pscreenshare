import { wallClock } from '../net/clock'
import { NO_REF } from '../proto/framing'
import { toBase64, type StreamInfo } from '../proto/messages'
import { frameReader } from './capture'
import type { EncodedFrame } from './packetizer'

const IDLE_REFRESH_MS = 400

export interface VideoEncoderOptions {
  bitrateKbps: number
  fps: number
  keyframeIntervalMs: number
}

interface Candidate {
  codec: string
  scalabilityMode?: string
  avc?: AvcEncoderConfig
}

// Prefer codecs with temporal scalability (lets relays shed frame rate under pressure).
const CANDIDATES: Candidate[] = [
  { codec: 'vp09.00.10.08', scalabilityMode: 'L1T3' },
  { codec: 'av01.0.04M.08', scalabilityMode: 'L1T3' },
  { codec: 'vp8', scalabilityMode: 'L1T3' },
  { codec: 'vp09.00.10.08' },
  { codec: 'avc1.42001f', avc: { format: 'annexb' } },
]

async function pickConfig(width: number, height: number, o: VideoEncoderOptions): Promise<VideoEncoderConfig> {
  for (const c of CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec: c.codec,
      width,
      height,
      bitrate: o.bitrateKbps * 1000,
      framerate: o.fps,
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      ...(c.scalabilityMode ? { scalabilityMode: c.scalabilityMode } : {}),
      ...(c.avc ? { avc: c.avc } : {}),
    }
    try {
      const res = await VideoEncoder.isConfigSupported(config)
      if (res.supported) return res.config ?? config
    } catch {
      // try next
    }
  }
  throw new Error('No supported WebCodecs video encoder configuration')
}

/**
 * Captures frames from a track and encodes them once (WebCodecs). Emits EncodedFrames with
 * temporal-layer and reference metadata, and StreamInfo whenever the decoder config changes.
 */
export class VideoPipeline {
  onFrame: (f: EncodedFrame) => void = () => {}
  onStreamInfo: (info: StreamInfo) => void = () => {}

  private encoder: VideoEncoder | null = null
  private config: VideoEncoderConfig | null = null
  private epoch = 0
  private seq = 0
  private gopId = 0
  private lastSeqByLayer: number[] = []
  private lastKeyAt = -Infinity
  private keyRequested = true
  private stopped = false
  private reader: ReturnType<typeof frameReader> | null = null
  private captureTimes = new Map<number, number>()
  private lastInfoKey = ''
  framesIn = 0
  framesDropped = 0

  constructor(
    private track: MediaStreamTrack,
    private opts: VideoEncoderOptions,
  ) {}

  get codec(): string | null {
    return this.config?.codec ?? null
  }

  requestKeyframe(): void {
    this.keyRequested = true
  }

  setBitrate(kbps: number): void {
    this.opts.bitrateKbps = kbps
    if (this.encoder && this.config) {
      this.config = { ...this.config, bitrate: kbps * 1000 }
      this.encoder.configure(this.config)
      this.keyRequested = true
    }
  }

  async start(): Promise<void> {
    this.reader = frameReader(this.track, this.opts.fps)
    // Screen capture only delivers frames when pixels change. Re-encode the last frame while idle so
    // stripes stay alive (silence means "dead parent" to viewers) and keyframes keep flowing.
    let last: VideoFrame | null = null
    let pending = this.reader.next()
    for (;;) {
      const res = await Promise.race([
        pending.then((f) => ({ f })),
        new Promise<null>((r) => setTimeout(() => r(null), IDLE_REFRESH_MS)),
      ])
      if (this.stopped) break
      let frame: VideoFrame
      if (res === null) {
        if (!last) continue
        frame = new VideoFrame(last, { timestamp: Math.round(performance.now() * 1000) })
      } else {
        if (!res.f) break
        pending = this.reader.next()
        frame = res.f
        last?.close()
        last = frame.clone()
      }
      this.framesIn++
      try {
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
    if (!this.encoder || !this.config || this.config.width !== width || this.config.height !== height) {
      await this.reconfigure(width, height)
    }
    const enc = this.encoder!
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
    if (this.encoder) {
      try {
        await this.encoder.flush()
      } catch {
        // ignore
      }
      this.encoder.close()
    }
    this.config = await pickConfig(width, height, this.opts)
    this.epoch = (this.epoch + 1) & 0xffff
    this.keyRequested = true
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.handleChunk(chunk, meta),
      error: (e) => console.error('VideoEncoder error', e),
    })
    this.encoder.configure(this.config)
  }

  private handleChunk(chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata): void {
    const captureTime = this.captureTimes.get(chunk.timestamp) ?? wallClock()
    this.captureTimes.delete(chunk.timestamp)
    if (this.captureTimes.size > 120) this.captureTimes.clear()

    if (meta?.decoderConfig) {
      const dc = meta.decoderConfig
      const info: StreamInfo = {
        epoch: this.epoch,
        codec: dc.codec,
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
    const layer = key ? 0 : (meta?.svc?.temporalLayerId ?? 0)
    const seq = this.seq
    this.seq = (this.seq + 1) >>> 0
    let refSeq = NO_REF
    if (key) {
      this.gopId = seq
      this.lastSeqByLayer = []
    } else {
      // L1Tn: Tn references the most recent frame of a lower layer; T0 references the previous T0.
      const lower = layer === 0 ? [this.lastSeqByLayer[0]] : this.lastSeqByLayer.slice(0, layer)
      const refs = lower.filter((x) => x !== undefined)
      refSeq = refs.length ? Math.max(...refs) : seq - 1
    }
    this.lastSeqByLayer[layer] = seq
    // A frame of layer L invalidates higher layers' references to older frames.
    this.lastSeqByLayer.length = layer + 1

    const data = new Uint8Array(chunk.byteLength)
    chunk.copyTo(data)
    this.onFrame({ epoch: this.epoch, seq, gopId: this.gopId, refSeq, key, layer, audio: false, captureTime, data })
  }

  stop(): void {
    this.stopped = true
    this.reader?.stop()
    try {
      this.encoder?.close()
    } catch {
      // ignore
    }
  }
}

function toBytes(src: AllowSharedBufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src.slice(0))
  const view = src as ArrayBufferView
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))
}
