// Stage selection: which stream is on the main stage, and which channels this peer should watch.
// Pure (no browser APIs), so it can be unit tested.

/** Main player quality: Auto (full, falling back to the preview when it stalls), Full or Preview. */
export type ViewQuality = 'auto' | 'full' | 'preview'
/** Where the stage picture comes from. */
export type StageSource = 'local' | 'full' | 'preview' | 'none'

export interface StageChannel {
  ann: { id: number; kind: 'full' | 'preview'; startedAt: number }
  publisher: string
}

/** Publishers with a live full channel, oldest stream first. */
export function liveStreamsOf<C extends StageChannel>(channels: C[]): C[] {
  return channels.filter((c) => c.ann.kind === 'full').sort((a, b) => a.ann.startedAt - b.ann.startedAt)
}

export interface StageInput<C extends StageChannel> {
  selfId: string
  /** Every live channel, including this peer's own. */
  channels: C[]
  selected: string | null
  quality: ViewQuality
  autoFallback: boolean
}

export interface StagePlan<C extends StageChannel> {
  /** The publisher on the stage (unchanged unless its stream ended or nothing was selected). */
  selected: string | null
  autoFallback: boolean
  /** The channels to watch, by channel id. */
  want: Map<number, C>
}

/**
 * Picks the stage stream (keeping the selection while its stream is live, else the oldest stream
 * of someone else, else this peer's own), and the channels to watch: the stage stream (full, or
 * its preview), and every other stream's preview while two or more are live (the tile rail). A
 * presenter sees its own capture locally.
 */
export function planStage<C extends StageChannel>(input: StageInput<C>): StagePlan<C> {
  const { selfId, channels, quality } = input
  const streams = liveStreamsOf(channels)
  let { selected, autoFallback } = input
  if (!selected || !streams.some((s) => s.publisher === selected)) {
    selected = streams.find((s) => s.publisher !== selfId)?.publisher ?? streams[0]?.publisher ?? null
    autoFallback = false
  }
  const previewOf = (publisher: string) => channels.find((c) => c.publisher === publisher && c.ann.kind === 'preview')
  const want = new Map<number, C>()
  const add = (c: C | undefined) => c && want.set(c.ann.id >>> 0, c)
  const stage = streams.find((s) => s.publisher === selected)
  if (stage && stage.publisher !== selfId) {
    if (quality !== 'preview') add(stage)
    if (quality === 'preview' || autoFallback) add(previewOf(stage.publisher))
  }
  if (streams.length >= 2) for (const s of streams) if (s.publisher !== selfId) add(previewOf(s.publisher))
  return { selected, autoFallback, want }
}

/** Auto quality falls back to the preview when the full stream stalls this long (ms)... */
export const AUTO_STALL_MS = 6000
/** ...and returns once it plays smoothly again for this long (ms). */
export const AUTO_RECOVER_MS = 4000

/**
 * Auto quality's stall detector: show the preview while the full stream stalls, and go back once it
 * recovers. A stall means frames stopped arriving: a static screen legitimately runs at a few fps
 * (only the idle refresh), and treating that as a stall would flip the stage back and forth.
 *
 * Progress is the stage subscription's decoded-frame counter, which every subscription starts
 * from 0: a new subscription (another stream on the stage, or the publisher restarted its share)
 * starts over, and so does a fallback changed elsewhere (a new selection, a quality change).
 */
export class AutoFallback {
  private sub: unknown = null
  private lastDecoded = 0
  private lastFallback = false
  private stallSince: number | null = null
  private smoothSince: number | null = null

  /** Forgets everything (quality left Auto). */
  reset(): void {
    this.sub = null
    this.lastDecoded = 0
    this.lastFallback = false
    this.stallSince = this.smoothSince = null
  }

  /**
   * One check. `sub` identifies the stage's full subscription (null: none), `decoded` is its
   * decoded-frame count, `fallback` whether the stage shows the preview now. Returns the next
   * fallback state.
   */
  step(now: number, sub: unknown, decoded: number, fallback: boolean): boolean {
    if (sub === null) {
      this.reset()
      return fallback
    }
    if (sub !== this.sub || fallback !== this.lastFallback) {
      if (sub !== this.sub) this.lastDecoded = 0
      this.sub = sub
      this.stallSince = this.smoothSince = null
    }
    const progressing = decoded > this.lastDecoded
    this.lastDecoded = decoded
    let next = fallback
    if (!fallback) {
      this.stallSince = progressing ? null : (this.stallSince ?? now)
      if (this.stallSince !== null && now - this.stallSince > AUTO_STALL_MS && decoded > 0) {
        next = true
        this.smoothSince = null
      }
    } else {
      this.smoothSince = progressing ? (this.smoothSince ?? now) : null
      if (this.smoothSince !== null && now - this.smoothSince > AUTO_RECOVER_MS) {
        next = false
        this.stallSince = null
      }
    }
    this.lastFallback = next
    return next
  }
}
