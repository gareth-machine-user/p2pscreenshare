import { wallClock } from '../net/clock'
import { sleep, sleepPrecise } from '../net/ticker'

export interface CaptureOptions {
  /** Which picker tab the browser should preselect. */
  surface?: 'monitor' | 'window' | 'browser'
  audio: boolean
  maxWidth?: number
  maxHeight?: number
}

export async function captureScreen(o: CaptureOptions): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 30, max: 30 },
      width: { max: o.maxWidth ?? 1920 },
      height: { max: o.maxHeight ?? 1080 },
      ...(o.surface ? { displaySurface: o.surface } : {}),
    },
    audio: o.audio,
  })
  for (const t of stream.getVideoTracks()) t.contentHint = 'detail'
  return stream
}

/**
 * Synthetic source for testing: an animated canvas that prints the host wall clock, so latency is
 * visible by eye when the host and a viewer are side by side.
 */
export function testPattern(width = 1280, height = 720, fps = 30, withAudio = false): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  let frame = 0
  const draw = () => {
    frame++
    const t = wallClock()
    ctx.fillStyle = '#101418'
    ctx.fillRect(0, 0, width, height)
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
  const timer = setInterval(draw, 1000 / fps)
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
      stream.getTracks().forEach((t) => t.stop())
      void audioCtx?.close()
    },
  }
}

/** Yields VideoFrames from a track (MediaStreamTrackProcessor, or a <video>+canvas fallback). */
export function frameReader(track: MediaStreamTrack, fps = 30): { next: () => Promise<VideoFrame | null>; stop: () => void } {
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
  video.srcObject = new MediaStream([track])
  void video.play()
  let stopped = false
  return {
    next: async () => {
      // Paced off the worker ticker as well as a main-thread timer: a presenter's tab is usually
      // hidden, where main-thread timers alone would capture about one frame a second.
      await sleepPrecise(1000 / fps)
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
