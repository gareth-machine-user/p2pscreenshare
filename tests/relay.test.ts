import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeFragment, encodeFragment, NO_REF, withReplayFlag } from '../src/proto/framing'
import type { MediaLink } from '../src/net/link'
import type { Uplink } from '../src/net/uplink'
import { RelayNode, REPLAY_REQUEST_MIN_MS } from '../src/relay/relayNode'

const CH = 1

interface Sent {
  to: string
  seq: number
  gop: number
  replay: boolean
}

let clock = 1000

/** One single-fragment video piece on `stripe`. */
function frag(o: { seq: number; gop?: number; key?: boolean; epoch?: number; stripe?: number; channel?: number; layer?: number; captureTime?: number }) {
  const stripe = o.stripe ?? 0
  return encodeFragment(
    {
      channel: o.channel ?? CH,
      key: o.key ?? false,
      audio: false,
      replay: false,
      layer: o.layer ?? 0,
      epoch: o.epoch ?? 1,
      frameSeq: o.seq,
      gopId: o.gop ?? o.seq,
      refSeq: o.key ? NO_REF : o.seq - 1,
      captureTime: o.captureTime ?? clock++,
      k: 2,
      m: 1,
      pieceIdx: stripe,
      stripe,
      frameLen: 8,
      fragIdx: 0,
      fragCount: 1,
    },
    new Uint8Array(8),
  )
}

function relay() {
  const sent: Sent[] = []
  const uplink = {
    send: (link: MediaLink & { peer: string }, data: Uint8Array) => {
      const h = decodeFragment(data)!.header
      sent.push({ to: link.peer, seq: h.frameSeq, gop: h.gopId, replay: h.replay })
    },
  } as unknown as Uplink
  const node = new RelayNode(uplink, (peer) => ({ isOpen: true, peer }) as unknown as MediaLink)
  node.verifier = async () => true
  return { node, sent }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

async function feed(node: RelayNode, frags: Uint8Array[], from = 'parent') {
  for (const f of frags) {
    node.receive(f, from)
    await settle()
  }
}

/** Frame seqs a newly attached child is replayed from the cache. */
function replayed(node: RelayNode, sent: Sent[], child = 'late', stripe = 0, channel = CH): number[] {
  const before = sent.length
  node.addChild(channel, stripe, child)
  return sent.slice(before).map((s) => s.seq)
}

describe('relay node', () => {
  it('forwards to children but never echoes back to the sender', async () => {
    const { node, sent } = relay()
    node.addChild(CH, 0, 'a')
    node.addChild(CH, 0, 'b')
    await feed(node, [frag({ seq: 1, key: true })], 'a')
    expect(sent.map((s) => s.to)).toEqual(['b'])
  })

  it('resets the GOP cache on a newer keyframe', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 10, key: true }), frag({ seq: 11, gop: 10 }), frag({ seq: 20, key: true }), frag({ seq: 21, gop: 20 })])
    expect(replayed(node, sent)).toEqual([20, 21])
    expect(sent.every((s) => s.replay)).toBe(true)
  })

  it('does not cache fragments of an older GOP', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 20, key: true }), frag({ seq: 12, gop: 10 }), frag({ seq: 21, gop: 20 })])
    expect(replayed(node, sent)).toEqual([20, 21])
  })

  it('a late keyframe of an older GOP does not evict the current one', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 20, key: true }), frag({ seq: 10, key: true }), frag({ seq: 21, gop: 20 })])
    expect(replayed(node, sent)).toEqual([20, 21])
  })

  it('a newer epoch resets the cache even with a lower gopId; an older one does not', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 20, key: true, epoch: 1 }), frag({ seq: 5, key: true, epoch: 2 }), frag({ seq: 6, gop: 5, epoch: 2 })])
    expect(replayed(node, sent, 'x')).toEqual([5, 6])
    await feed(node, [frag({ seq: 30, key: true, epoch: 1 })])
    expect(replayed(node, sent, 'y')).toEqual([5, 6])
  })

  it('orders GOPs across u32 wraparound', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 0xfffffff0, key: true }), frag({ seq: 3, key: true }), frag({ seq: 4, gop: 3 })])
    expect(replayed(node, sent)).toEqual([3, 4])
    await feed(node, [frag({ seq: 0xfffffff8, key: true })])
    expect(replayed(node, sent, 'other')).toEqual([3, 4])
  })

  it('dropChannel and removePeer touch only the named channel ("1:" is not "11:")', async () => {
    const { node, sent } = relay()
    await feed(node, [frag({ seq: 1, key: true, channel: 1 }), frag({ seq: 2, key: true, channel: 11 })])
    node.addChild(1, 0, 'c')
    node.addChild(11, 0, 'c')
    node.removePeer('c', 1)
    expect(node.childrenOf(1, 0)).toEqual([])
    expect(node.childrenOf(11, 0)).toEqual(['c'])

    node.dropChannel(1)
    expect(node.lastRecv.has('1:0')).toBe(false)
    expect(node.lastRecv.has('11:0')).toBe(true)
    expect(replayed(node, sent, 'd', 0, 1)).toEqual([])
    expect(replayed(node, sent, 'd', 0, 11)).toEqual([2])
  })
})

describe('relay node: replay on request (need-gop)', () => {
  let now = 50_000
  afterEach(() => vi.restoreAllMocks())
  const useClock = () => vi.spyOn(performance, 'now').mockImplementation(() => now)

  /** A GOP on stripe 0 (key 10, T0 12, T1/T2 11 and 13) and one on stripe 1. */
  async function cached() {
    const r = relay()
    await feed(r.node, [
      frag({ seq: 10, key: true }),
      frag({ seq: 11, gop: 10, layer: 2 }),
      frag({ seq: 12, gop: 10, layer: 0 }),
      frag({ seq: 13, gop: 10, layer: 1 }),
      frag({ seq: 10, key: true, stripe: 1 }),
    ])
    return r
  }

  it('replays the cached keyframe and base layer only to the asking child, per its stripes', async () => {
    useClock()
    const { node, sent } = await cached()
    node.addChild(CH, 0, 'a')
    node.addChild(CH, 0, 'b')
    node.addChild(CH, 1, 'a')
    now += REPLAY_REQUEST_MIN_MS // past the attach replays
    sent.length = 0
    node.requestReplay(CH, [0, 1], 'a')
    expect(sent).toEqual([
      { to: 'a', seq: 10, gop: 10, replay: true },
      { to: 'a', seq: 12, gop: 10, replay: true },
      { to: 'a', seq: 10, gop: 10, replay: true }, // stripe 1's keyframe
    ])
  })

  it('ignores peers that are not our child on the stripe', async () => {
    useClock()
    const { node, sent } = await cached()
    node.addChild(CH, 1, 'a')
    now += REPLAY_REQUEST_MIN_MS
    sent.length = 0
    node.requestReplay(CH, [0], 'a') // a child, but on stripe 1 only
    node.requestReplay(CH, [0, 1], 'stranger')
    expect(sent).toEqual([])
  })

  it('serves each child at most once per REPLAY_REQUEST_MIN_MS per stripe, counting the attach replay', async () => {
    useClock()
    const { node, sent } = await cached()
    node.addChild(CH, 0, 'a')
    node.addChild(CH, 1, 'a')
    node.addChild(CH, 0, 'b')
    sent.length = 0
    node.requestReplay(CH, [0], 'a') // right after attaching
    expect(sent).toEqual([])
    now += REPLAY_REQUEST_MIN_MS
    node.requestReplay(CH, [0], 'a')
    node.requestReplay(CH, [0], 'a')
    expect(sent.map((s) => s.to)).toEqual(['a', 'a'])
    // Other stripes and other children have their own budget.
    sent.length = 0
    now += 10
    node.requestReplay(CH, [1], 'a')
    node.requestReplay(CH, [0], 'b')
    expect(sent.map((s) => s.to)).toEqual(['a', 'b', 'b'])
    now += REPLAY_REQUEST_MIN_MS - 20
    sent.length = 0
    node.requestReplay(CH, [0], 'a')
    expect(sent).toEqual([])
    now += 10
    node.requestReplay(CH, [0], 'a')
    expect(sent).toHaveLength(2)
  })

  it('plays already-seen replayed fragments locally only while it expects a replay', async () => {
    useClock()
    const { node, sent } = relay()
    const played: number[] = []
    node.onFragment = (f) => played.push(f.header.frameSeq)
    node.addChild(CH, 0, 'kid')
    const key = frag({ seq: 10, key: true })
    await feed(node, [key])
    expect(played).toEqual([10])
    // A duplicate replay without having asked: dropped as before.
    await feed(node, [withReplayFlag(key)])
    expect(played).toEqual([10])
    node.expectReplay(CH, [0])
    sent.length = 0
    await feed(node, [withReplayFlag(key)])
    expect(played).toEqual([10, 10])
    expect(sent).toEqual([]) // not forwarded again
    // Not on other stripes, and not once the window is over.
    await feed(node, [withReplayFlag(frag({ seq: 10, key: true, stripe: 1 })), withReplayFlag(frag({ seq: 10, key: true, stripe: 1 }))])
    expect(played).toEqual([10, 10, 10])
    now += 60_000
    await feed(node, [withReplayFlag(key)])
    expect(played).toEqual([10, 10, 10])
  })

  it('accepts replays older than the de-dup window (long GOPs) but does not forward them', async () => {
    const { node, sent } = relay()
    const played: number[] = []
    node.onFragment = (f) => played.push(f.header.frameSeq)
    node.addChild(CH, 0, 'kid')
    const t = clock
    await feed(node, [frag({ seq: 100, gop: 90, captureTime: t + 9000 })])
    sent.length = 0
    // Live fragments that old are rejected; a cached GOP's keyframe that old is played and cached.
    await feed(node, [frag({ seq: 89, gop: 80, captureTime: t }), withReplayFlag(frag({ seq: 90, key: true, captureTime: t + 100 }))])
    expect(played).toEqual([100, 90])
    expect(node.rejected).toBe(1)
    expect(sent).toEqual([])
    expect(replayed(node, sent, 'late')).toEqual([90])
  })

  it('rejects "replays" older than a GOP (the replay flag is not signed)', async () => {
    const { node } = relay()
    const played: number[] = []
    node.onFragment = (f) => played.push(f.header.frameSeq)
    const t = clock
    await feed(node, [frag({ seq: 500, gop: 490, captureTime: t + 60_000 })])
    await feed(node, [withReplayFlag(frag({ seq: 10, key: true, captureTime: t }))])
    expect(played).toEqual([500])
    expect(node.rejected).toBe(1)
  })
})

describe('relay node: media lanes', () => {
  /** A relay whose lane lookup reports `peer/index`, recording what goes where. */
  function laned() {
    const sent: { link: string; stripe: number; channel: number; replay: boolean }[] = []
    const uplink = {
      send: (link: MediaLink & { name: string }, data: Uint8Array) => {
        const h = decodeFragment(data)!.header
        sent.push({ link: link.name, stripe: h.stripe, channel: h.channel, replay: h.replay })
      },
    } as unknown as Uplink
    const node = new RelayNode(uplink, (peer, index) => ({ isOpen: true, name: `${peer}/${index}` }) as unknown as MediaLink)
    node.verifier = async () => true
    return { node, sent }
  }

  it('numbers the trees sent to a peer, so its stripes spread over its lanes (forwarding and replays)', async () => {
    const { node, sent } = laned()
    for (const s of [0, 1, 2]) node.addChild(CH, s, 'c')
    await feed(node, [0, 1, 2].map((s) => frag({ seq: 1, key: true, stripe: s })))
    expect(sent.map((x) => [x.link, x.stripe])).toEqual([
      ['c/0', 0],
      ['c/1', 1],
      ['c/2', 2],
    ])
    sent.length = 0
    // A new child's catch-up replay: its only tree, so its first lane.
    node.addChild(CH, 1, 'd')
    expect(sent).toEqual([{ link: 'd/0', stripe: 1, channel: CH, replay: true }])
  })

  it('ranks the stripes a pair actually carries: stripes 0 and 2 get indices 0 and 1', async () => {
    const { node, sent } = laned()
    node.addChild(CH, 0, 'c')
    node.addChild(CH, 2, 'c')
    await feed(node, [0, 2, 0, 2].map((s, i) => frag({ seq: 1 + (i >> 1), key: i < 2, gop: 1, stripe: s })))
    expect(sent.map((x) => [x.stripe, x.link])).toEqual([
      [0, 'c/0'],
      [2, 'c/1'],
      [0, 'c/0'],
      [2, 'c/1'],
    ])
  })

  it('ranks across channels, and re-ranks when a tree is added or removed', async () => {
    const { node, sent } = laned()
    const PREVIEW = 7
    node.addChild(CH, 0, 'c')
    node.addChild(CH, 2, 'c')
    node.addChild(PREVIEW, 0, 'c')
    await feed(node, [frag({ seq: 1, key: true, stripe: 0, channel: PREVIEW }), frag({ seq: 1, key: true, stripe: 2 })])
    expect(sent.map((x) => [x.channel, x.stripe, x.link])).toEqual([
      [PREVIEW, 0, 'c/2'],
      [CH, 2, 'c/1'],
    ])
    sent.length = 0
    node.removeChild(CH, 0, 'c')
    await feed(node, [frag({ seq: 2, key: true, stripe: 2 })])
    expect(sent.map((x) => x.link)).toEqual(['c/0'])
  })
})
