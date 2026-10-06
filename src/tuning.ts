// Latency versus quality. Every knob that trades delay for smooth, complete frames lives here.
// Screen sharing favours quality: a few hundred milliseconds more delay is barely noticeable,
// dropped or skipped frames are. `?priority=latency` (page or hash query) picks the low-latency
// profile instead.

export interface Tuning {
  priority: 'quality' | 'latency'
  /** How long an uplink may queue a fragment of each temporal layer before dropping it (ms). */
  maxAgeByLayer: [number, number, number, number]
  /** Keyframe fragments (a late keyframe still unlocks every frame after it). */
  keyMaxAgeMs: number
  /** GOP-cache replays to a newly attached child. */
  replayMaxAgeMs: number
  /** Jitter buffer: play at this quantile of arrival times, plus a safety margin, at least minDelay. */
  playoutQuantile: number
  playoutSafetyMs: number
  playoutMinDelayMs: number
  /** How long the media data channel keeps retransmitting a lost packet (ms). */
  mediaMaxPacketLifeTimeMs: number
  /** Congestion control backs off when sent fragments waited longer than this on average (ms). */
  ccQueueMs: number
  /** A stripe silent this long means its parent is gone or stalled (ms). */
  stripeSilenceMs: number
  keyframeIntervalMs: number
}

const PROFILES: Record<Tuning['priority'], Tuning> = {
  quality: {
    priority: 'quality',
    maxAgeByLayer: [2500, 1500, 800, 800],
    keyMaxAgeMs: 4000,
    replayMaxAgeMs: 4000,
    playoutQuantile: 0.99,
    playoutSafetyMs: 120,
    playoutMinDelayMs: 150,
    mediaMaxPacketLifeTimeMs: 3000,
    ccQueueMs: 800,
    stripeSilenceMs: 1500,
    keyframeIntervalMs: 3000,
  },
  latency: {
    priority: 'latency',
    maxAgeByLayer: [900, 350, 180, 180],
    keyMaxAgeMs: 2000,
    replayMaxAgeMs: 2500,
    playoutQuantile: 0.95,
    playoutSafetyMs: 40,
    playoutMinDelayMs: 30,
    mediaMaxPacketLifeTimeMs: 1000,
    ccQueueMs: 250,
    stripeSilenceMs: 1000,
    keyframeIntervalMs: 2000,
  },
}

function pick(): Tuning['priority'] {
  if (typeof location === 'undefined') return 'quality'
  const hashQuery = location.hash.split('?')[1] ?? ''
  const p = new URLSearchParams(location.search).get('priority') ?? new URLSearchParams(hashQuery).get('priority')
  return p === 'latency' ? 'latency' : 'quality'
}

export const tuning: Tuning = PROFILES[pick()]
