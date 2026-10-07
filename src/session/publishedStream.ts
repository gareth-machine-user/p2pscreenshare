// A shared screen (or camera): capture and encoding (WebCodecs), the audio mixer, the preview channel's
// downscaler, and quality/bitrate changes. Each encoded channel is handed to a ChannelPublisher
// (channelPublisher.ts), which plans its trees.
import { AudioPipeline } from '../media/audio'
import { cameraConstraints, captureCamera, captureScreen, testPattern, type CameraFacing, type TestPatternKind } from '../media/capture'
import { AudioMixer, captureMic } from '../media/mixer'
import { VideoPipeline } from '../media/encoder'
import type { EncoderRates } from '../proto/messages'
import { RateWindow, round1 } from './rates'
import { ChannelPublisher, type PublisherContext } from './channelPublisher'
import { tuning } from '../tuning'

export interface ShareOptions {
  k: number
  m: number
  bitrateKbps: number
  /** Capture and encoding frame rate of the full channel (default 30). */
  fps?: number
  source: 'screen' | 'camera' | 'test'
  /** Picker hint for screen capture. */
  surface?: 'monitor' | 'window' | 'browser'
  /** Which camera, for a camera source. */
  facing?: CameraFacing
  maxSize?: [number, number]
  /** Capture system/tab audio (or the test tone). A camera has none: its sound is the mic. */
  audio: boolean
  /** Mix in the microphone. */
  mic?: boolean
  /** Test pattern size, e.g. [1280, 720]. */
  testSize?: [number, number]
  /** Test pattern variant (media/capture.ts testPattern). */
  testPattern?: TestPatternKind
}

/** Capture and encoding frame rate of the full channel when the options give none. */
const DEFAULT_FPS = 30
/** Congestion control never takes the encoder below this, and moves it in these steps (kbps). */
const MIN_ADAPTIVE_KBPS = 300
const BITRATE_STEP_KBPS = 50
/** Test pattern size when none is given. */
const DEFAULT_TEST_SIZE: [number, number] = [1280, 720]

/** Draws a random u32 channel id. */
function newChannelId(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

/** The low-resolution preview channel every stream also publishes (tiles, weak downlinks). */
const PREVIEW = { width: 320, height: 180, fps: 5, kbps: 120 }

/**
 * A shared screen: one capture, encoded once per channel. The full-resolution channel carries the
 * audio; the preview channel gets a downscaled copy of every 5th-of-a-second frame.
 */
export class PublishedStream {
  localStream: MediaStream | null = null
  readonly channels: ChannelPublisher[] = []
  /** What audio the stream carries (the browser may give no system audio, e.g. for windows). */
  audio = { system: false, mic: false, systemMuted: false, micMuted: false }
  private video: VideoPipeline | null = null
  private preview: VideoPipeline | null = null
  private audioPipe: AudioPipeline | null = null
  private mixer: AudioMixer | null = null
  private micTrack: MediaStreamTrack | null = null
  private stopSource: (() => void) | null = null
  private lastPreviewAt = -Infinity
  private previewCanvas: OffscreenCanvas | null = null
  private previewBusy = false
  private stopped = false

  constructor(
    readonly opts: ShareOptions,
    private ctx: PublisherContext,
  ) {
    this.ceilingKbps = opts.bitrateKbps
  }

  get full(): ChannelPublisher | undefined {
    return this.channels.find((c) => c.kind === 'full')
  }

  get previewChannel(): ChannelPublisher | undefined {
    return this.channels.find((c) => c.kind === 'preview')
  }

  get codec(): string | null {
    return this.video?.codec ?? null
  }

  async start(): Promise<void> {
    const o = this.opts
    let stream: MediaStream
    if (o.source === 'test') {
      const [w, h] = o.testSize ?? DEFAULT_TEST_SIZE
      const tp = testPattern(w, h, o.fps ?? DEFAULT_FPS, o.audio, o.testPattern)
      stream = tp.stream
      this.stopSource = tp.stop
    } else if (o.source === 'camera') {
      stream = await captureCamera({ facing: o.facing ?? 'user', width: o.maxSize?.[0], height: o.maxSize?.[1], fps: o.fps ?? DEFAULT_FPS })
      this.stopSource = () => this.localStream?.getTracks().forEach((t) => t.stop())
    } else {
      stream = await captureScreen({ surface: o.surface, audio: o.audio, maxWidth: o.maxSize?.[0], maxHeight: o.maxSize?.[1], fps: o.fps ?? DEFAULT_FPS })
      this.stopSource = () => stream.getTracks().forEach((t) => t.stop())
    }
    this.localStream = stream
    // stop() may have run while the screen picker was open: release what it couldn't see yet.
    if (this.stopped) return this.stop()

    // System/tab audio and the microphone are mixed into one track.
    const systemTrack = o.audio && o.source !== 'camera' ? (stream.getAudioTracks()[0] ?? null) : null
    this.micTrack = o.mic ? await captureMic() : null
    if (this.stopped) return this.stop()
    const canEncodeAudio = AudioPipeline.supported()
    if (canEncodeAudio && (systemTrack || this.micTrack)) this.mixer = new AudioMixer(systemTrack, this.micTrack)
    this.audio = { system: !!systemTrack, mic: !!this.micTrack, systemMuted: false, micMuted: false }
    const withAudio = !!this.mixer

    const full = new ChannelPublisher(newChannelId(), 'full', o.k, o.m, o.bitrateKbps, withAudio, this.ctx, () => this.video?.requestKeyframe())
    const preview = new ChannelPublisher(newChannelId(), 'preview', 1, 0, PREVIEW.kbps, false, this.ctx, () => this.preview?.requestKeyframe())
    this.channels.push(full, preview)

    const vt = stream.getVideoTracks()[0]
    this.video = new VideoPipeline(vt, { bitrateKbps: o.bitrateKbps, fps: o.fps ?? DEFAULT_FPS, keyframeIntervalMs: tuning.keyframeIntervalMs })
    this.video.onFrame = (f) => full.emit(f)
    this.video.onStreamInfo = (info) => full.setStream({ ...info, audio: this.audioPipe?.info ?? undefined })
    this.video.onRawFrame = (frame) => this.feedPreview(frame)
    void this.video.start()

    this.preview = new VideoPipeline(null, { bitrateKbps: PREVIEW.kbps, fps: PREVIEW.fps, keyframeIntervalMs: tuning.keyframeIntervalMs })
    this.preview.onFrame = (f) => preview.emit(f)
    this.preview.onStreamInfo = (info) => preview.setStream(info)

    if (this.mixer) {
      this.audioPipe = new AudioPipeline(this.mixer.track)
      this.audioPipe.onFrame = (f) => {
        // The decoder config learns about audio once the encoder is configured.
        if (full.stream && !full.stream.audio && this.audioPipe?.info) full.setStream({ ...full.stream, audio: this.audioPipe.info })
        full.emit(f)
      }
      this.audioPipe.start().catch((e) => console.warn('audio disabled', e))
    }
    // Ending the capture from the browser's own "Stop sharing" bar ends the stream too.
    vt.addEventListener('ended', this.onTrackEnded)
    this.ctx.announce()
  }

  private onTrackEnded = () => this.onEnded()

  /** The camera in use, for a camera source. */
  get facing(): CameraFacing | null {
    return this.opts.source === 'camera' ? (this.opts.facing ?? 'user') : null
  }

  /**
   * Switches to the other camera in place: the same channels carry on (a keyframe, maybe a new
   * size), with no new share. The old camera is released first, since phones often can't open two.
   */
  async switchCamera(facing: CameraFacing): Promise<void> {
    if (this.opts.source !== 'camera' || !this.video || this.stopped) return
    const old = this.localStream?.getVideoTracks()[0]
    old?.removeEventListener('ended', this.onTrackEnded)
    old?.stop()
    let stream: MediaStream
    try {
      stream = await captureCamera({ facing, width: this.opts.maxSize?.[0], height: this.opts.maxSize?.[1], fps: this.opts.fps ?? DEFAULT_FPS })
    } catch (e) {
      // Back to the camera we had, if it will open again; else the stream has no video left.
      try {
        stream = await captureCamera({ facing: this.facing ?? 'user', width: this.opts.maxSize?.[0], height: this.opts.maxSize?.[1], fps: this.opts.fps ?? DEFAULT_FPS })
      } catch {
        this.onEnded()
        throw e
      }
      this.useCamera(stream)
      throw e
    }
    ;(this.opts as { facing?: CameraFacing }).facing = facing
    this.useCamera(stream)
  }

  private useCamera(stream: MediaStream): void {
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const vt = stream.getVideoTracks()[0]
    vt.addEventListener('ended', this.onTrackEnded)
    this.localStream = stream
    this.video?.replaceTrack(vt)
    this.ctx.announce()
  }

  /** Downscales a captured frame for the preview channel, at most PREVIEW.fps times a second. */
  private feedPreview(frame: VideoFrame): void {
    const now = performance.now()
    if (!this.preview || this.previewBusy || now - this.lastPreviewAt < 1000 / PREVIEW.fps) return
    this.lastPreviewAt = now
    const scale = Math.min(PREVIEW.width / frame.displayWidth, PREVIEW.height / frame.displayHeight, 1)
    const w = Math.max(2, Math.round((frame.displayWidth * scale) / 2) * 2)
    const h = Math.max(2, Math.round((frame.displayHeight * scale) / 2) * 2)
    if (!this.previewCanvas || this.previewCanvas.width !== w || this.previewCanvas.height !== h) this.previewCanvas = new OffscreenCanvas(w, h)
    const g = this.previewCanvas.getContext('2d')!
    g.drawImage(frame, 0, 0, w, h)
    const small = new VideoFrame(this.previewCanvas, { timestamp: frame.timestamp })
    this.previewBusy = true
    void this.preview.encodeExternal(small).finally(() => (this.previewBusy = false))
  }

  /**
   * Changes bitrate, capture size cap and frame rate in place: the encoder is rebuilt (choosing
   * the codec again for the new bits per pixel) and sends a keyframe, with no new capture (which
   * would need the user to pick a screen again) and no new channel.
   */
  async setQuality(bitrateKbps: number, maxSize?: [number, number], fps?: number): Promise<void> {
    const full = this.full
    if (!full || !this.video) return
    const o = this.opts as { bitrateKbps: number; maxSize?: [number, number]; fps?: number }
    const rate = fps ?? o.fps ?? DEFAULT_FPS
    this.ceilingKbps = bitrateKbps
    full.kbps = bitrateKbps
    o.bitrateKbps = bitrateKbps
    o.fps = rate
    this.video.setTarget(bitrateKbps, rate)
    const track = this.localStream?.getVideoTracks()[0]
    if (track && this.opts.source !== 'test') {
      const size = maxSize ?? o.maxSize
      const constraints =
        this.opts.source === 'camera'
          ? cameraConstraints({ facing: this.facing ?? undefined, width: size?.[0], height: size?.[1], fps: rate })
          : { ...(size ? { width: { max: size[0] }, height: { max: size[1] } } : {}), frameRate: { ideal: rate, max: rate } }
      await track.applyConstraints(constraints).catch((e) => console.warn('capture change failed', e))
      if (maxSize) o.maxSize = maxSize
    }
    full.limited = null
    this.ctx.announce()
  }

  /** The most the bitrate may go up to: the quality the presenter chose. */
  ceilingKbps: number

  /** Adapts the encoder's bitrate (congestion control) without changing the chosen quality. */
  adaptBitrate(kbps: number): void {
    const full = this.full
    if (!full || !this.video) return
    const next = Math.round(Math.min(this.ceilingKbps, Math.max(MIN_ADAPTIVE_KBPS, kbps)) / BITRATE_STEP_KBPS) * BITRATE_STEP_KBPS
    if (next === full.kbps) return
    full.kbps = next
    this.video.setBitrate(next)
    this.ctx.announce()
  }

  private encoderWindow = new RateWindow<{ captured: number; encoded: number; dropped: number; keyframes: number; bytes: number }>()

  /** The full channel's encoder over the window since the previous call. */
  sampleEncoder(): EncoderRates | null {
    const v = this.video
    if (!v) return null
    const r = this.encoderWindow.sample({
      captured: v.framesIn,
      encoded: v.framesEncoded,
      dropped: v.framesDropped,
      keyframes: v.keyframes,
      bytes: v.bytesOut,
    })
    return {
      codec: v.codec,
      targetKbps: this.full?.kbps ?? this.opts.bitrateKbps,
      ceilingKbps: this.ceilingKbps,
      kbps: Math.round((r.bytes * 8) / 1000),
      captureFps: round1(r.captured),
      encodedFps: round1(r.encoded),
      droppedFps: round1(r.dropped),
      keyframes: round1(r.keyframes),
      encodeMs: round1(v.encodeMs),
      maxFrameKB: round1(v.takeMaxFrameBytes() / 1024),
    }
  }

  setSystemMuted(muted: boolean): void {
    this.mixer?.setSystemMuted(muted)
    this.audio = { ...this.audio, systemMuted: muted }
  }

  setMicMuted(muted: boolean): void {
    this.mixer?.setMicMuted(muted)
    this.audio = { ...this.audio, micMuted: muted }
  }

  onEnded: () => void = () => {}

  stop(): void {
    this.stopped = true
    this.video?.stop()
    this.preview?.stop()
    this.audioPipe?.stop()
    this.mixer?.close()
    this.micTrack?.stop()
    this.stopSource?.()
    for (const c of this.channels) c.stop()
    this.channels.length = 0
    this.ctx.announce()
  }
}
