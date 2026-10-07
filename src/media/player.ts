import { wallClock } from '../net/clock'
import { fromBase64, type StreamInfo } from '../proto/messages'
import { AudioPlayer } from './audio'
import { DecodeScheduler, PlayoutClock } from './jitterBuffer'
import type { AssembledFrame } from './reassembler'

/** Most frames of a not-yet-announced epoch kept while waiting for its StreamInfo. */
const MAX_EARLY_FRAMES = 120
/** How far ahead of its render time a frame is decoded (ms); the rest of the buffer stays encoded. */
const DECODE_AHEAD_MS = 300

/** The StreamInfo fields the video decoder is configured from. */
function videoKey(info: StreamInfo): string {
  return JSON.stringify([info.epoch, info.codec, info.codedWidth, info.codedHeight, info.description ?? null])
}

interface Pending {
  frame: VideoFrame
  renderAt: number
}

export interface PlayerStats {
  latencyMs: number | null
  bufferMs: number
  fps: number
  decodedFrames: number
  droppedFrames: number
  waitingForKeyframe: boolean
  width: number
  height: number
  /** Cumulative: frames that arrived after their play time, whose reference was missing, that
   * were skipped waiting for a missing frame, and decoded frames replaced before being shown. */
  late: number
  undecodable: number
  skipped: number
  notRendered: number
}

/**
 * Viewer playback: jitter buffer + dependency-aware decode ordering + WebCodecs decoding +
 * render scheduling on the playout clock. Audio shares the same playout clock.
 */
export class Player {
  readonly clock = new PlayoutClock()
  readonly scheduler: DecodeScheduler
  readonly audio = new AudioPlayer()
  /** host clock - local clock (ms), from clock sync; used only for latency reporting. */
  clockOffset: number | null = null

  private decoder: VideoDecoder | null = null
  private info: StreamInfo | null = null
  private renderQueue: Pending[] = []
  private renderAtByTs = new Map<number, number>()
  private captureByTs = new Map<number, number>()
  /** Video frames of an epoch whose StreamInfo hasn't arrived yet, and the last epoch replaced. */
  private early: AssembledFrame[] = []
  private retiredEpoch: number | null = null
  private raf = 0
  private interval: ReturnType<typeof setInterval>
  private renderedTimes: number[] = []
  private latencySamples: number[] = []
  private lastRendered: VideoFrame | null = null
  private closed = false
  private notRendered = 0
  width = 0
  height = 0

  constructor(
    private canvas: HTMLCanvasElement | null,
    onNeedKeyframe: () => void,
  ) {
    this.scheduler = new DecodeScheduler(this.clock, onNeedKeyframe)
    const loop = () => {
      this.tick()
      if (!this.closed) this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
    // rAF pauses in background tabs; keep the pipeline draining anyway.
    this.interval = setInterval(() => this.tick(), 50)
  }

  /** Extra canvases drawing the same frames (a preview shows in its tile and on the stage). */
  private extraCanvases = new Set<HTMLCanvasElement>()

  setCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
  }

  /** Draws into another canvas too, starting with the last frame; returns a detach function. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.extraCanvases.add(canvas)
    if (this.lastRendered) this.draw(canvas, this.lastRendered)
    return () => this.extraCanvases.delete(canvas)
  }

  private draw(c: HTMLCanvasElement, frame: VideoFrame): void {
    if (document.hidden) return
    if (c.width !== frame.displayWidth || c.height !== frame.displayHeight) {
      c.width = frame.displayWidth
      c.height = frame.displayHeight
    }
    c.getContext('2d')!.drawImage(frame, 0, 0)
  }

  setStreamInfo(info: StreamInfo, force = false): void {
    if (!force && this.info && JSON.stringify(this.info) === JSON.stringify(info)) return
    const prev = this.info
    this.info = info
    if (info.audio) this.audio.configure(info.audio)
    // Only the video fields feed the decoder; e.g. audio being added later must not reset video.
    if (!force && prev && videoKey(prev) === videoKey(info)) return
    this.rebuildDecoder(info, prev)
  }

  private rebuildDecoder(info: StreamInfo, prev: StreamInfo | null): void {
    try {
      // A decoder that reported an error is already closed, and closing it again throws.
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    } catch {
      // Closing is best effort: the decoder is being replaced either way.
    }
    this.renderAtByTs.clear()
    if (prev && prev.epoch !== info.epoch) this.retiredEpoch = prev.epoch
    // Frames of this epoch that arrived before its StreamInfo (often including its keyframe).
    const held = this.early.filter((f) => f.epoch === info.epoch)
    if (held.length) this.early = []
    // A new decoder needs a keyframe. A new epoch starts with one, so only ask when rebuilding
    // within an epoch (decoder error, config change) and none is already in hand.
    this.scheduler.reset(prev !== null && prev.epoch === info.epoch && !held.some((f) => f.key))
    for (const f of held) this.scheduler.push(f)
    const decoder = new VideoDecoder({
      output: (f) => this.onDecoded(f),
      error: (e) => {
        console.warn('VideoDecoder error; resetting', e)
        // A decoder error closes the decoder: rebuild it and resume from the next keyframe.
        setTimeout(() => {
          if (this.closed || this.decoder !== decoder || !this.info) return
          this.rebuildDecoder(this.info, this.info)
        }, 0)
      },
    })
    this.decoder = decoder
    const config: VideoDecoderConfig = {
      codec: info.codec,
      codedWidth: info.codedWidth,
      codedHeight: info.codedHeight,
      optimizeForLatency: true,
      ...(info.description ? { description: fromBase64(info.description) } : {}),
    }
    try {
      decoder.configure(config)
    } catch (err) {
      console.warn('VideoDecoder configure failed', err)
    }
  }

  push(f: AssembledFrame): void {
    if (!f.replay) this.clock.addSample(f.captureTime, f.completedAt)
    if (f.audio) {
      this.audio.push(f, this.clock.renderAt(f.captureTime))
      return
    }
    if (!this.info || f.epoch !== this.info.epoch) {
      this.holdEarly(f)
      return
    }
    this.scheduler.push(f)
    this.pump()
  }

  /** Keeps frames of an epoch whose StreamInfo hasn't arrived yet (only the latest such epoch). */
  private holdEarly(f: AssembledFrame): void {
    if (f.epoch === this.retiredEpoch) return
    if (this.early.length && this.early[0].epoch !== f.epoch) this.early = []
    this.early.push(f)
    if (this.early.length > MAX_EARLY_FRAMES) this.early.shift()
  }

  private pump(): void {
    if (!this.decoder || this.decoder.state !== 'configured') return
    for (const f of this.scheduler.poll(wallClock(), DECODE_AHEAD_MS)) {
      const ts = Math.round(f.captureTime * 1000)
      // Entries are removed on output; failed decodes would otherwise leak them.
      if (this.renderAtByTs.size >= 300) this.renderAtByTs.clear()
      this.renderAtByTs.set(ts, this.clock.renderAt(f.captureTime) ?? wallClock())
      this.captureByTs.set(ts, f.captureTime)
      try {
        this.decoder.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: ts, data: f.data }))
      } catch (err) {
        console.warn('decode error', err)
      }
    }
  }

  private onDecoded(frame: VideoFrame): void {
    const renderAt = this.renderAtByTs.get(frame.timestamp) ?? wallClock()
    this.renderAtByTs.delete(frame.timestamp)
    this.renderQueue.push({ frame, renderAt })
  }

  private tick(): void {
    this.pump()
    // Lets the audio jitter buffer give up on a missing frame once a later one is due.
    this.audio.pump()
    const now = wallClock()
    // Show the newest frame that is due; drop older due frames.
    let due: Pending | null = null
    while (this.renderQueue.length && this.renderQueue[0].renderAt <= now) {
      if (due) {
        due.frame.close()
        this.notRendered++
      }
      due = this.renderQueue.shift()!
    }
    // Guard against unbounded growth if the clock jumps.
    while (this.renderQueue.length > 90) {
      this.renderQueue.shift()!.frame.close()
      this.notRendered++
    }
    if (!due) return
    this.render(due.frame, now)
  }

  private render(frame: VideoFrame, now: number): void {
    const capture = this.captureByTs.get(frame.timestamp)
    this.captureByTs.delete(frame.timestamp)
    if (this.captureByTs.size > 300) this.captureByTs.clear()
    if (capture !== undefined && this.clockOffset !== null) {
      this.latencySamples.push(now + this.clockOffset - capture)
      if (this.latencySamples.length > 90) this.latencySamples.shift()
    }
    this.renderedTimes.push(now)
    while (this.renderedTimes.length && now - this.renderedTimes[0] > 1000) this.renderedTimes.shift()

    this.width = frame.displayWidth
    this.height = frame.displayHeight
    if (this.canvas) this.draw(this.canvas, frame)
    for (const c of this.extraCanvases) this.draw(c, frame)
    this.lastRendered?.close()
    this.lastRendered = frame
  }

  get stats(): PlayerStats {
    const lat = [...this.latencySamples].sort((a, b) => a - b)
    const s = this.scheduler.stats
    return {
      latencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
      bufferMs: this.clock.bufferMs,
      fps: this.renderedTimes.length,
      decodedFrames: s.decoded,
      droppedFrames: s.droppedLate + s.droppedUndecodable,
      waitingForKeyframe: this.scheduler.waitingForKeyframe,
      width: this.width,
      height: this.height,
      late: s.droppedLate,
      undecodable: s.droppedUndecodable,
      skipped: s.skippedMissing,
      notRendered: this.notRendered,
    }
  }

  close(): void {
    this.closed = true
    cancelAnimationFrame(this.raf)
    clearInterval(this.interval)
    this.renderQueue.forEach((p) => p.frame.close())
    this.lastRendered?.close()
    this.early = []
    try {
      this.decoder?.close()
    } catch {
      // An errored decoder is already closed, and closing it again throws.
    }
    this.audio.close()
  }
}
