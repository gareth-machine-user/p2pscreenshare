import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveStreamsOf, planStage, type StageChannel, type ViewQuality } from '../src/session/stage'
import { HeadroomProbe, PROBE_BUFFER, PROBE_CHUNK, PROBE_DURATION_MS, PROBE_MAX_GAP_MS, probeStarved } from '../src/session/headroom'
import { deliveredKbps } from '../src/session/capacity'
import type { LinkState, ProbeLink } from '../src/net/link'
import { Uplink } from '../src/net/uplink'
import { resetTicker } from '../src/net/ticker'

const SELF = 'self'
let nextId = 1
function stream(publisher: string, startedAt: number, preview = true): StageChannel[] {
  const out: StageChannel[] = [{ publisher, ann: { id: nextId++, kind: 'full', startedAt } }]
  if (preview) out.push({ publisher, ann: { id: nextId++, kind: 'preview', startedAt } })
  return out
}
const fullOf = (cs: StageChannel[], p: string) => cs.find((c) => c.publisher === p && c.ann.kind === 'full')!.ann.id
const previewOf = (cs: StageChannel[], p: string) => cs.find((c) => c.publisher === p && c.ann.kind === 'preview')!.ann.id
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b)

function plan(channels: StageChannel[], selected: string | null, quality: ViewQuality = 'auto', autoFallback = false) {
  const r = planStage({ selfId: SELF, channels, selected, quality, autoFallback })
  return { ...r, ids: sorted([...r.want.keys()]) }
}

describe('stage selection', () => {
  it('orders streams oldest first, full channels only', () => {
    const cs = [...stream('b', 20), ...stream('a', 10)]
    expect(liveStreamsOf(cs).map((c) => c.publisher)).toEqual(['a', 'b'])
  })

  it('selects nothing when nothing is live', () => {
    expect(plan([], 'gone')).toMatchObject({ selected: null, ids: [] })
  })

  it("picks the oldest stream of someone else, over this peer's own", () => {
    const cs = [...stream(SELF, 1), ...stream('b', 3), ...stream('a', 2)]
    expect(plan(cs, null).selected).toBe('a')
  })

  it('falls back to its own stream when it is the only one', () => {
    expect(plan(stream(SELF, 1), null)).toMatchObject({ selected: SELF, ids: [] })
  })

  it('keeps a live selection, and resets auto fallback when the selection ends', () => {
    const cs = [...stream('a', 1), ...stream('b', 2)]
    expect(plan(cs, 'b', 'auto', true)).toMatchObject({ selected: 'b', autoFallback: true })
    expect(plan(cs, 'gone', 'auto', true)).toMatchObject({ selected: 'a', autoFallback: false })
  })

  it('watches the full stream only, with a single stream in auto or full quality', () => {
    const cs = stream('a', 1)
    expect(plan(cs, 'a', 'auto').ids).toEqual([fullOf(cs, 'a')])
    expect(plan(cs, 'a', 'full').ids).toEqual([fullOf(cs, 'a')])
  })

  it('watches the preview only in preview quality', () => {
    const cs = stream('a', 1)
    expect(plan(cs, 'a', 'preview').ids).toEqual([previewOf(cs, 'a')])
  })

  it('watches both while auto quality has fallen back', () => {
    const cs = stream('a', 1)
    expect(plan(cs, 'a', 'auto', true).ids).toEqual(sorted([fullOf(cs, 'a'), previewOf(cs, 'a')]))
  })

  it("watches every other stream's preview while two or more are live, never its own", () => {
    const cs = [...stream(SELF, 0), ...stream('a', 1), ...stream('b', 2)]
    expect(plan(cs, 'b').ids).toEqual(sorted([previewOf(cs, 'a'), fullOf(cs, 'b'), previewOf(cs, 'b')]))
  })

  it('watches only the rail while presenting', () => {
    const cs = [...stream(SELF, 0), ...stream('a', 1)]
    expect(plan(cs, SELF).ids).toEqual([previewOf(cs, 'a')])
  })

  it('tolerates a stream without a preview', () => {
    const cs = [...stream('a', 1, false), ...stream('b', 2)]
    expect(plan(cs, 'a', 'preview').ids).toEqual([previewOf(cs, 'b')])
  })
})

describe('headroom probe starvation', () => {
  const ok = { maxGapMs: 50, elapsedMs: PROBE_DURATION_MS + 10 }
  it('keeps a probe with regular refills', () => {
    expect(probeStarved(ok)).toBe(false)
  })
  it('discards a probe whose sending was starved', () => {
    expect(probeStarved({ ...ok, maxGapMs: PROBE_MAX_GAP_MS + 1 })).toBe(true)
    // The end deadline fired late: the main thread was busy or throttled.
    expect(probeStarved({ ...ok, elapsedMs: PROBE_DURATION_MS + PROBE_MAX_GAP_MS + 1 })).toBe(true)
  })
})

/** A bin channel whose buffer the test drains, firing buffer-low events like an RTCDataChannel. */
class StubProbeLink implements ProbeLink {
  isOpen = true
  state: LinkState = 'open'
  bufferedAmount = 0
  sent = 0
  onBufferLow: (() => void) | null = null
  /** As a real `bin` channel's (mesh/meshConn.ts setUpBin). */
  bufferLowThreshold = PROBE_BUFFER / 2
  send(data: Uint8Array): boolean {
    this.bufferedAmount += data.byteLength
    this.sent += data.byteLength
    return true
  }
  drain(bytes: number): void {
    const before = this.bufferedAmount
    this.bufferedAmount = Math.max(0, before - bytes)
    if (before > this.bufferLowThreshold && this.bufferedAmount <= this.bufferLowThreshold) this.onBufferLow?.()
  }
}

describe('headroom probe', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    resetTicker()
  })
  afterEach(() => {
    resetTicker()
    vi.useRealTimers()
  })

  /** Runs a probe over links each draining `bytesPerMs[i]`; returns each link's delivered kbps. */
  async function run(bytesPerMs: number[], during?: (t: number, links: StubProbeLink[]) => void) {
    const uplink = new Uplink()
    const links = bytesPerMs.map(() => new StubProbeLink())
    const probe = new HeadroomProbe(uplink)
    const snap = () => ({ at: performance.now(), links: links.map((l) => ({ handed: uplink.perLink.get(l)?.handedBytes ?? 0, buffered: l.bufferedAmount })) })
    const result = probe.run(links, snap)
    for (let t = 0; t < PROBE_DURATION_MS + 100; t++) {
      during?.(t, links)
      links.forEach((l, i) => l.drain(bytesPerMs[i]))
      await vi.advanceTimersByTimeAsync(1)
    }
    const r = await result
    const kbps = r ? r.start.links.map((a, i) => deliveredKbps(r.end.links[i].handed - a.handed, a.buffered, r.end.links[i].buffered, r.end.at - r.start.at)) : null
    return { kbps, links, uplink, probe }
  }

  it('keeps fast links busy from buffer-low events and measures what each delivered', async () => {
    // 100 Mbps and 20 Mbps.
    const { kbps, links, uplink, probe } = await run([12_500, 2500])
    expect(kbps).not.toBeNull()
    expect(kbps![0]).toBeGreaterThan(100_000 * 0.9)
    expect(kbps![0]).toBeLessThan(100_000 * 1.05)
    expect(kbps![1]).toBeGreaterThan(20_000 * 0.9)
    expect(kbps![1]).toBeLessThan(20_000 * 1.05)
    for (const l of links) {
      // The handler is cleared, and nothing is left queued.
      expect(l.onBufferLow).toBeNull()
      expect(uplink.queued(l)).toBe(0)
    }
    expect(probe.running).toBe(false)
    expect(probe.lastAt).toBeGreaterThan(-Infinity)
  })

  it('keeps at most PROBE_BUFFER in a channel, however fast it drains', async () => {
    // The bin channel shares its SCTP association with the media channel (and ctl): a deep backlog
    // there stalled the association in Chromium.
    let maxBuffered = 0
    await run([12_500], (_, [l]) => (maxBuffered = Math.max(maxBuffered, l.bufferedAmount)))
    expect(maxBuffered).toBeLessThanOrEqual(PROBE_BUFFER + PROBE_CHUNK)
  })

  it('does nothing without links, or while one runs', async () => {
    const probe = new HeadroomProbe(new Uplink())
    expect(await probe.run([], () => 0)).toBeNull()
    expect(probe.lastAt).toBe(-Infinity)
  })
})
