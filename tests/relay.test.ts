import { describe, expect, it } from 'vitest'
import { decodeFragment, encodeFragment, NO_REF } from '../src/proto/framing'
import type { MediaLink } from '../src/net/link'
import type { Uplink } from '../src/net/uplink'
import { RelayNode } from '../src/relay/relayNode'

const CH = 1

interface Sent {
  to: string
  seq: number
  gop: number
  replay: boolean
}

let clock = 1000

/** One single-fragment video piece on `stripe`. */
function frag(o: { seq: number; gop?: number; key?: boolean; epoch?: number; stripe?: number; channel?: number }) {
  const stripe = o.stripe ?? 0
  return encodeFragment(
    {
      channel: o.channel ?? CH,
      key: o.key ?? false,
      audio: false,
      replay: false,
      layer: 0,
      epoch: o.epoch ?? 1,
      frameSeq: o.seq,
      gopId: o.gop ?? o.seq,
      refSeq: o.key ? NO_REF : o.seq - 1,
      captureTime: clock++,
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
