import { describe, expect, it } from 'vitest'
import { liveStreamsOf, planStage, type StageChannel, type ViewQuality } from '../src/session/stage'
import { shuffle, UploadProbe, type UploadProbeContext } from '../src/session/uploadProbe'
import type { PeerMsg } from '../src/proto/messages'

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
      uplink: { stats: { sentBytes: 0 }, setBackground: () => {}, queued: () => 0, send: () => {} },
      capacity: { probeKbps: null, setProbe: () => {} },
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
