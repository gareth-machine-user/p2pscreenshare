import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTO_RECOVER_MS, AUTO_STALL_MS, AutoFallback, liveStreamsOf, planStage, type StageChannel, type ViewQuality } from '../src/session/stage'
import { discoveryDue, HEADROOM_EVERY_MS, HEADROOM_FIRST_MS, HEADROOM_FIRST_VIEWER_MS, HEADROOM_LIMITED_MS, HeadroomProbe, PROBE_BUFFER, PROBE_CHUNK, PROBE_DURATION_MS, PROBE_MAX_GAP_MS, probeStarved } from '../src/session/headroom'
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

describe('auto quality fallback', () => {
  const TICK = 500
  /** Steps every TICK ms for `ms`, the counter advancing by `perTick` each step; returns the last state. */
  function run(a: AutoFallback, t: { now: number; decoded: number }, sub: object, ms: number, perTick: number, fallback: boolean): boolean {
    for (let end = t.now + ms; t.now < end; ) {
      t.now += TICK
      t.decoded += perTick
      fallback = a.step(t.now, sub, t.decoded, fallback)
    }
    return fallback
  }

  it('falls back after a stall, and returns once the stream plays again', () => {
    const a = new AutoFallback()
    const sub = {}
    const t = { now: 0, decoded: 0 }
    expect(run(a, t, sub, 2000, 15, false)).toBe(false)
    expect(run(a, t, sub, AUTO_STALL_MS - TICK, 0, false)).toBe(false)
    expect(run(a, t, sub, 3 * TICK, 0, false)).toBe(true)
    expect(run(a, t, sub, AUTO_RECOVER_MS, 15, true)).toBe(true)
    expect(run(a, t, sub, 2 * TICK, 15, true)).toBe(false)
  })

  it('a new stage subscription starts from its own counter, not the previous one', () => {
    const a = new AutoFallback()
    const t = { now: 0, decoded: 0 }
    // Long on stream A: its counter is far ahead.
    run(a, t, {}, 60_000, 15, false)
    // B's counter starts at 0 and is far behind A's, but it plays.
    const b = {}
    const tb = { now: t.now, decoded: 0 }
    expect(run(a, tb, b, 3 * AUTO_STALL_MS, 15, false)).toBe(false)
    // In fallback on a new subscription, progress brings it back.
    const c = {}
    const tc = { now: tb.now, decoded: 0 }
    expect(run(a, tc, c, AUTO_RECOVER_MS + 2 * TICK, 15, true)).toBe(false)
  })

  it('forgets an old stall when quality leaves auto, or the fallback is changed elsewhere', () => {
    const a = new AutoFallback()
    const sub = {}
    const t = { now: 0, decoded: 0 }
    run(a, t, sub, 1000, 15, false)
    run(a, t, sub, AUTO_STALL_MS - 1000, 0, false) // stalled, not yet long enough
    a.reset() // quality changed away from auto, and back much later
    t.now += 60_000
    expect(run(a, t, sub, TICK, 0, false)).toBe(false)
    // A fallback turned off elsewhere (a new selection) restarts the stall timer.
    const u = { now: 0, decoded: 0 }
    const b = new AutoFallback()
    run(b, u, sub, AUTO_STALL_MS - 1000, 0, false)
    expect(b.step((u.now += TICK), sub, u.decoded, true)).toBe(true)
    expect(run(b, u, sub, TICK, 0, false)).toBe(false)
  })

  it('without a stage subscription, nothing changes', () => {
    const a = new AutoFallback()
    expect(a.step(10_000, null, 0, true)).toBe(true)
    expect(a.step(20_000, null, 0, false)).toBe(false)
  })
})

describe('headroom discovery schedule', () => {
  const base = { now: 0, firstLinkAt: 0, lastAt: 0, presenting: true, limited: false, encoderKbps: 4000, targetKbps: 4000 }
  it('first shortly after the first link, then every 30 s', () => {
    expect(discoveryDue({ ...base, lastAt: -Infinity, now: HEADROOM_FIRST_MS - 1 })).toBe(false)
    expect(discoveryDue({ ...base, lastAt: -Infinity, now: HEADROOM_FIRST_MS })).toBe(true)
    expect(discoveryDue({ ...base, now: HEADROOM_LIMITED_MS })).toBe(false)
    expect(discoveryDue({ ...base, now: HEADROOM_EVERY_MS })).toBe(true)
  })

  it("a viewer's first probe waits out its join", () => {
    const viewer = { ...base, presenting: false, lastAt: -Infinity, encoderKbps: null, targetKbps: null }
    expect(discoveryDue({ ...viewer, now: HEADROOM_FIRST_MS })).toBe(false)
    expect(discoveryDue({ ...viewer, now: HEADROOM_FIRST_VIEWER_MS })).toBe(true)
  })

  it('every 5 s while a capacity limit holds down a bitrate the encoder uses', () => {
    expect(discoveryDue({ ...base, limited: true, now: HEADROOM_LIMITED_MS })).toBe(true)
  })

  it('not every 5 s for a static screen far below its bitrate: the limit costs it nothing', () => {
    expect(discoveryDue({ ...base, limited: true, encoderKbps: 300, now: HEADROOM_LIMITED_MS })).toBe(false)
    expect(discoveryDue({ ...base, limited: true, encoderKbps: null, targetKbps: null, now: HEADROOM_LIMITED_MS })).toBe(false)
    expect(discoveryDue({ ...base, limited: true, encoderKbps: 300, now: HEADROOM_EVERY_MS })).toBe(true)
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
    const snap = () => ({ at: performance.now(), links: links.map((l) => ({ handed: uplink.countersOf(l)?.handedBytes ?? 0, buffered: l.bufferedAmount })) })
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
