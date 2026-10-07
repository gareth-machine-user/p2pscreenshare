import { wallClock } from '../net/clock'
import { every, sleep, sleepPrecise } from '../net/ticker'

export interface CaptureOptions {
  /** Which picker tab the browser should preselect. */
  surface?: 'monitor' | 'window' | 'browser'
  audio: boolean
  maxWidth?: number
  maxHeight?: number
  /** Capture frame rate (default 30). */
  fps?: number
}

export async function captureScreen(o: CaptureOptions): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: o.fps ?? 30, max: o.fps ?? 30 },
      width: { max: o.maxWidth ?? 1920 },
      height: { max: o.maxHeight ?? 1080 },
      ...(o.surface ? { displaySurface: o.surface } : {}),
    },
    audio: o.audio,
  })
  for (const t of stream.getVideoTracks()) t.contentHint = 'detail'
  return stream
}

/** Whether this browser can capture the screen (phones can't: they share a camera instead). */
export function canCaptureScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function'
}

export function canCaptureCamera(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}

/** Which camera: the front (selfie) one or the back one. */
export type CameraFacing = 'user' | 'environment'

/**
 * A camera's video, sized as `ideal` constraints rather than maxima: a phone held upright delivers
 * portrait frames, which a landscape maximum would reject or crop. The encoder follows whatever
 * size (and rotation) arrives.
 */
export async function captureCamera(o: { facing: CameraFacing; width?: number; height?: number; fps?: number }): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(o), audio: false })
  for (const t of stream.getVideoTracks()) t.contentHint = 'motion'
  return stream
}

export function cameraConstraints(o: { facing?: CameraFacing; width?: number; height?: number; fps?: number }): MediaTrackConstraints {
  return {
    ...(o.facing ? { facingMode: { ideal: o.facing } } : {}),
    width: { ideal: o.width ?? 1280 },
    height: { ideal: o.height ?? 720 },
    frameRate: { ideal: o.fps ?? 30, max: o.fps ?? 30 },
  }
}

/**
 * Synthetic source for testing: an animated canvas that prints the host wall clock, so latency is
 * visible by eye when the host and a viewer are side by side. Variants: `busy`, a rotating, zooming
 * noise background that motion search can't predict, so the encoder runs at its full target
 * bitrate (like a video playing on a shared screen) instead of the ~2 Mbps the plain bars need;
 * `bursty`, that background still except for half a second every four (like a screen that is
 * mostly static, with the odd scroll or window switch).
 */
export type TestPatternKind = 'bars' | 'busy' | 'bursty'

export function testPattern(width = 1280, height = 720, fps = 30, withAudio = false, kind: TestPatternKind = 'bars'): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const noise = kind !== 'bars' ? noiseTile(256) : null
  let frame = 0
  /** The background's animation step: every frame when busy, in bursts when bursty. */
  let step = 0
  const draw = () => {
    frame++
    const t = wallClock()
    if (kind === 'busy' || (kind === 'bursty' && frame % (4 * fps) < fps / 2)) step++
    if (noise) {
      ctx.save()
      ctx.translate(width / 2, height / 2)
      ctx.rotate(step * 0.05)
      const zoom = 1 + 0.3 * Math.sin(step * 0.11)
      ctx.scale(zoom, zoom)
      ctx.fillStyle = ctx.createPattern(noise, 'repeat')!
      const r = Math.hypot(width, height)
      ctx.fillRect(-r, -r, 2 * r, 2 * r)
      ctx.restore()
    } else {
      ctx.fillStyle = '#101418'
      ctx.fillRect(0, 0, width, height)
    }
    // Moving bars make dropped/late frames obvious.
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = `hsl(${(i * 45 + frame) % 360} 70% 55%)`
      const x = ((frame * (i + 2) * 3) % (width + 200)) - 200
      ctx.fillRect(x, 80 + i * 60, 200, 40)
    }
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 72px monospace'
    const d = new Date(t)
    const clock = `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`
    ctx.fillText(clock, 40, height - 120)
    ctx.font = '32px monospace'
    ctx.fillText(`frame ${frame}`, 40, height - 60)
  }
  draw()
  // A main-thread timer paces it while the tab is visible; the worker ticker (50 ms) keeps it
  // drawing in a hidden tab, where main-thread timers run once a second (a real screen capture
  // isn't throttled either).
  let lastDraw = performance.now()
  const tick = () => {
    const now = performance.now()
    if (now - lastDraw < 1000 / fps - 4) return
    lastDraw = now
    draw()
  }
  const timer = setInterval(tick, 1000 / fps)
  const stopTicker = every(50, tick)
  const stream = canvas.captureStream(fps)
  // A quiet tone, so audio paths can be tested without a real capture.
  let audioCtx: AudioContext | null = null
  if (withAudio && typeof AudioContext !== 'undefined') {
    audioCtx = new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    gain.gain.value = 0.05
    const dest = audioCtx.createMediaStreamDestination()
    osc.connect(gain).connect(dest)
    osc.start()
    for (const t of dest.stream.getAudioTracks()) stream.addTrack(t)
  }
  return {
    stream,
    stop: () => {
      clearInterval(timer)
      stopTicker()
      stream.getTracks().forEach((t) => t.stop())
      void audioCtx?.close()
    },
  }
}

/** A square canvas of random grey-ish pixels. */
function noiseTile(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')!
  const img = g.createImageData(size, size)
  const rnd = crypto.getRandomValues(new Uint8Array(size * size))
  for (let i = 0; i < rnd.length; i++) {
    const v = rnd[i]
    img.data[4 * i] = v
    img.data[4 * i + 1] = (v * 7) & 255
    img.data[4 * i + 2] = 255 - v
    img.data[4 * i + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}

/** Yields VideoFrames from a track (MediaStreamTrackProcessor, or a <video>+canvas fallback). */
/** `fps` paces the fallback reader (a function: the frame rate can change mid-stream). */
export function frameReader(track: MediaStreamTrack, fps: number | (() => number) = 30): { next: () => Promise<VideoFrame | null>; stop: () => void } {
  const rate = typeof fps === 'function' ? fps : () => fps
  if (typeof MediaStreamTrackProcessor !== 'undefined') {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
    return {
      next: async () => {
        const { value, done } = await reader.read()
        return done ? null : (value ?? null)
      },
      stop: () => void reader.cancel().catch(() => {}),
    }
  }
  // Fallback (Safari/Firefox main thread): sample a <video> element.
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.autoplay = true
  video.srcObject = new MediaStream([track])
  void video.play()
  let stopped = false
  return {
    next: async () => {
      // Paced off the worker ticker as well as a main-thread timer: a presenter's tab is usually
      // hidden, where main-thread timers alone would capture about one frame a second.
      await sleepPrecise(1000 / rate())
      while (!stopped && video.readyState < 2) await sleep(50)
      if (stopped) return null
      return new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) })
    },
    stop: () => {
      stopped = true
      video.srcObject = null
    },
  }
}
