// Video quality as the presenter chooses it: a resolution, a frame rate and a quality level, or a
// custom bitrate. A level is a density of bits per pixel, so the same level means the same visual
// quality whatever the resolution and frame rate; its bitrate is derived here. Pure, for tests.

export type Resolution = 'native' | '2160' | '1440' | '1080' | '720' | '540'
export type Fps = 30 | 60
export type QualityLevel = 'low' | 'standard' | 'high' | 'very-high' | 'lossless'

export interface VideoQuality {
  resolution: Resolution
  fps: Fps
  level: QualityLevel
  /** Overrides the level's bitrate when set (kbps). */
  customKbps: number | null
}

export const RESOLUTIONS: readonly { value: Resolution; label: string }[] = [
  { value: 'native', label: 'Native' },
  { value: '2160', label: '2160p (4K)' },
  { value: '1440', label: '1440p' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '540', label: '540p' },
]

export const FPS_OPTIONS: readonly Fps[] = [30, 60]

/** Each level's bitrate at 1080p30 (kbps); other sizes and rates scale from it (levelKbps). */
export const LEVELS: readonly { value: QualityLevel; label: string; kbps1080p30: number }[] = [
  { value: 'low', label: 'Low', kbps1080p30: 2500 },
  { value: 'standard', label: 'Standard', kbps1080p30: 5000 },
  { value: 'high', label: 'High', kbps1080p30: 9000 },
  { value: 'very-high', label: 'Very high', kbps1080p30: 15000 },
  { value: 'lossless', label: 'Near-lossless', kbps1080p30: 25000 },
]

/** Range of the custom bitrate (kbps). */
export const CUSTOM_KBPS = { min: 500, max: 150_000 } as const

export const DEFAULT_QUALITY: VideoQuality = { resolution: '1080', fps: 30, level: 'standard', customKbps: null }

const PIXELS_1080P = 1920 * 1080

/**
 * The capture size cap for a resolution: 16:9 boxes, so a wider or taller source keeps its aspect
 * inside them. Native is uncapped (up to 8K).
 */
export function maxSizeFor(res: Resolution): [number, number] {
  if (res === 'native') return [7680, 4320]
  const h = Number(res)
  return [Math.round((h * 16) / 9), h]
}

/** Pixels per frame at a resolution; native uses the screen's size in device pixels. */
export function pixelsFor(res: Resolution, nativeSize: [number, number] = [1920, 1080]): number {
  if (res === 'native') return nativeSize[0] * nativeSize[1]
  const [w, h] = maxSizeFor(res)
  return w * h
}

/**
 * A level's bitrate for a frame size and rate. Bigger and smoother frames need less per pixel
 * (more of each frame is predictable), so it scales by pixels^0.75 and frame rate^0.7 from the
 * 1080p30 figure. Rounded to 100 kbps, or 500 kbps above 10 Mbps.
 */
export function levelKbps(level: QualityLevel, pixels: number, fps: number): number {
  const base = LEVELS.find((l) => l.value === level)?.kbps1080p30 ?? LEVELS[1].kbps1080p30
  const kbps = base * (pixels / PIXELS_1080P) ** 0.75 * (fps / 30) ** 0.7
  const step = kbps > 10_000 ? 500 : 100
  return Math.max(CUSTOM_KBPS.min, Math.round(kbps / step) * step)
}

/** The bitrate a quality asks for (kbps). */
export function targetKbps(q: VideoQuality, nativeSize?: [number, number]): number {
  if (q.customKbps !== null) return clampKbps(q.customKbps)
  return levelKbps(q.level, pixelsFor(q.resolution, nativeSize), q.fps)
}

export function clampKbps(kbps: number): number {
  return Math.round(Math.min(CUSTOM_KBPS.max, Math.max(CUSTOM_KBPS.min, kbps)))
}

/** "1080p60 · High · 15 Mbps" */
export function describeQuality(q: VideoQuality, nativeSize?: [number, number]): string {
  const res = q.resolution === 'native' ? 'Native' : `${q.resolution}p`
  const level = q.customKbps !== null ? 'Custom' : (LEVELS.find((l) => l.value === q.level)?.label ?? q.level)
  return `${res}${q.fps} · ${level} · ${fmtRate(targetKbps(q, nativeSize))}`
}

export function fmtRate(kbps: number): string {
  return kbps >= 1000 ? `${+(kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1)} Mbps` : `${kbps} kbps`
}

/**
 * Bits per pixel at which the encoder prefers a hardware H.264 encoder over software VP9:
 * software VP9 in real-time mode stops gaining quality from extra bits well before this.
 * Between "Standard" (0.08 at 1080p30, 0.065 at 60 fps) and "High" (0.145, 0.117 at 60 fps).
 */
export const HIGH_BPP = 0.1

export function bitsPerPixel(kbps: number, width: number, height: number, fps: number): number {
  return (kbps * 1000) / (width * height * fps)
}

/**
 * Maps a quality preset from before resolution and bitrate were separate (settings stored by an
 * older version) to the nearest new choice.
 */
export function fromLegacyPreset(preset: unknown): { quality: VideoQuality; autoLower: boolean } | null {
  const q = (resolution: Resolution, level: QualityLevel): VideoQuality => ({ resolution, fps: 30, level, customKbps: null })
  switch (preset) {
    case 'auto':
      return { quality: q('1080', 'standard'), autoLower: true }
    case '4k':
      return { quality: q('2160', 'standard'), autoLower: false }
    case '2k':
      return { quality: q('1440', 'high'), autoLower: false }
    case '1080p-ultra':
      return { quality: q('1080', 'very-high'), autoLower: false }
    case '1080p-hi':
      return { quality: q('1080', 'high'), autoLower: false }
    case '1080p':
      return { quality: q('1080', 'standard'), autoLower: false }
    case '720p':
      return { quality: q('720', 'standard'), autoLower: false }
    case 'low':
      return { quality: q('540', 'low'), autoLower: false }
    default:
      return null
  }
}
