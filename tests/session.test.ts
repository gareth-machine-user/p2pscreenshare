import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveStreamsOf, planStage, type StageChannel, type ViewQuality } from '../src/session/stage'
import { PROBE_DURATION_MS, PROBE_MAX_GAP_MS, probeDiscardReason, shuffle, UploadProbe, type UploadProbeContext } from '../src/session/uploadProbe'
import type { PeerMsg } from '../src/proto/messages'
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

describe('shuffle', () => {
  it('is a permutation', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i)
    expect(sorted(shuffle([...xs]))).toEqual(xs)
  })

  it('is unbiased over the orders of a small array', () => {
    const counts = new Map<string, number>()
    const n = 60_000
    for (let i = 0; i < n; i++) {
      const k = shuffle(['a', 'b', 'c']).join('')
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    expect(counts.size).toBe(6)
    for (const c of counts.values()) expect(Math.abs(c / n - 1 / 6)).toBeLessThan(0.01)
  })
})

describe('upload probe (receiving side)', () => {
  function setup() {
    const sent: { to: string; msg: PeerMsg }[] = []
    const ctx: UploadProbeContext = {
      targets: () => [],
      uplink: { stats: { sentBytes: 0, droppedBackground: 0 }, setBackground: () => {}, queued: () => 0, send: () => {}, forget: () => {}, kick: () => {} },
      capacity: { probeKbps: null, setProbe: () => true },
      sendTo: (to, msg) => sent.push({ to, msg }),
      onProbed: () => {},
    }
    return { p: new UploadProbe(ctx), sent }
  }
  const chunk = (id: number, size = 1024) => {
    const c = new Uint8Array(size)
    new DataView(c.buffer).setUint32(0, id, true)
    return c
  }

  it('counts bytes after the first chunk, per sender and probe id', () => {
    const { p, sent } = setup()
    p.onChunk(chunk(7), 'a')
    p.onChunk(chunk(7), 'a')
    p.onChunk(chunk(7), 'a')
    p.onChunk(chunk(8), 'a')
    p.onChunk(chunk(7), 'b')
    p.onEnd(7, 'a')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('a')
    expect(sent[0].msg).toMatchObject({ t: 'probe-result', bytes: 2048 })
    // Ended: a second end marker reports nothing.
    p.onEnd(7, 'a')
    expect(sent[1].msg).toEqual({ t: 'probe-result', bytes: 0, ms: 0 })
  })

  it('ignores runt chunks', () => {
    const { p, sent } = setup()
    p.onChunk(new Uint8Array(3), 'a')
    p.onEnd(0, 'a')
    expect(sent[0].msg).toEqual({ t: 'probe-result', bytes: 0, ms: 0 })
  })

  it('does nothing without open neighbours', async () => {
    const { p } = setup()
    expect(await p.probe()).toBeNull()
    expect(p.lastProbeAt).toBeGreaterThan(-Infinity)
  })
})

describe('upload probe discard', () => {
  const ok = { maxGapMs: 50, elapsedMs: PROBE_DURATION_MS + 10 }
  it('keeps a probe with regular refills', () => {
    expect(probeDiscardReason(ok)).toBeNull()
  })
  it('discards a probe whose sending was starved', () => {
    expect(probeDiscardReason({ ...ok, maxGapMs: PROBE_MAX_GAP_MS + 1 })).toBe('starved')
    // The end deadline fired late: the main thread was busy or throttled.
    expect(probeDiscardReason({ ...ok, elapsedMs: PROBE_DURATION_MS + PROBE_MAX_GAP_MS + 1 })).toBe('starved')
  })
})

/** A probe channel whose buffer the test drains, firing buffer-low events like an RTCDataChannel. */
class StubProbeLink implements ProbeLink {
  isOpen = true
  state: LinkState = 'open'
  bufferedAmount = 0
  sent = 0
  onBufferLow: (() => void) | null = null
  bufferLowThreshold = 0
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

describe('upload probe (sending side)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
    resetTicker()
  })
  afterEach(() => {
    resetTicker()
    vi.useRealTimers()
  })

  function setup(n: number) {
    const links = Array.from({ length: n }, () => new StubProbeLink())
    const uplink = new Uplink()
    const sent: { to: string; msg: PeerMsg }[] = []
    const probes: number[] = []
    let probed = 0
    const ctx: UploadProbeContext = {
      targets: () => links.map((l, i) => ({ remoteId: `p${i}`, isOpen: true, probeLink: l })),
      uplink,
      capacity: {
        probeKbps: null,
        setProbe: (k) => {
          probes.push(k)
          return true
        },
      },
      sendTo: (to, msg) => sent.push({ to, msg }),
      onProbed: () => probed++,
    }
    return { p: new UploadProbe(ctx), links, uplink, sent, probes, probed: () => probed }
  }

  /** Runs a probe whose links each drain `bytesPerMs`; receivers report what they got. */
  async function run(s: ReturnType<typeof setup>, bytesPerMs: number, during?: (t: number) => void) {
    const result = s.p.probe()
    for (let t = 0; t < PROBE_DURATION_MS + 100; t++) {
      during?.(t)
      for (const l of s.links) l.drain(bytesPerMs)
      await vi.advanceTimersByTimeAsync(1)
    }
    for (const { to, msg } of s.sent) if (msg.t === 'probe-end') s.p.onResult(to, { bytes: s.links[Number(to.slice(1))].sent, ms: PROBE_DURATION_MS })
    return result
  }

  it('keeps fast links busy from buffer-low events (100 Mbps each)', async () => {
    const s = setup(3)
    const rate = 12_500 // bytes per ms: 100 Mbps
    const kbps = await run(s, rate)
    for (const l of s.links) {
      // Nearly all of 1.5 s at full rate went out on each link...
      expect(l.sent).toBeGreaterThan(rate * PROBE_DURATION_MS * 0.9)
      // The channel's own low mark and handler are restored afterwards.
      expect(l.bufferLowThreshold).toBe(0)
      expect(l.onBufferLow).toBeNull()
    }
    expect(kbps).toBeGreaterThan(3 * 100_000 * 0.9)
    expect(s.probes).toHaveLength(1)
    expect(s.probed()).toBe(1)
    // Nothing left queued to trail the end marker.
    for (const l of s.links) expect(s.uplink.queued(l)).toBe(0)
  })

  it('grows the buffer allowance with the measured rate', async () => {
    const s = setup(1)
    let maxThreshold = 0
    await run(s, 12_500, () => (maxThreshold = Math.max(maxThreshold, s.links[0].bufferLowThreshold)))
    // About 40 ms of 12.5 KB/ms, halved for the low mark.
    expect(maxThreshold).toBeGreaterThan(200 * 1024)
  })

  it('probes every lane of a neighbour in parallel and reports their sum', async () => {
    // One neighbour, three connections, each draining 1 MB/s (its own congestion window).
    const lanes = [new StubProbeLink(), new StubProbeLink(), new StubProbeLink()]
    const sent: { to: string; msg: PeerMsg }[] = []
    const probes: number[] = []
    const p = new UploadProbe({
      targets: () => [{ remoteId: 'v', isOpen: true, probeLink: lanes[0], probeLinks: lanes }],
      uplink: new Uplink(),
      capacity: {
        probeKbps: null,
        setProbe: (k) => {
          probes.push(k)
          return true
        },
      },
      sendTo: (to, msg) => sent.push({ to, msg }),
      onProbed: () => {},
    })
    const result = p.probe()
    for (let t = 0; t < PROBE_DURATION_MS + 100; t++) {
      for (const l of lanes) l.drain(1000)
      await vi.advanceTimersByTimeAsync(1)
    }
    // One end marker for the neighbour, which reports what arrived on all its lanes together.
    expect(sent.filter((s) => s.msg.t === 'probe-end')).toHaveLength(1)
    for (const l of lanes) expect(l.sent).toBeGreaterThan(1000 * PROBE_DURATION_MS * 0.9)
    p.onResult('v', { bytes: lanes.reduce((a, l) => a + l.sent, 0), ms: PROBE_DURATION_MS })
    const kbps = await result
    // ~3 × 8 Mbps: the aggregate, not one connection's ceiling.
    expect(kbps).toBeGreaterThan(3 * 8000 * 0.9)
    expect(probes).toEqual([kbps])
  })
})
