// Media lanes (mesh/lanes.ts): extra connections per mesh pair, on the in-memory network under
// fake time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ban } from '../src/mesh/auth'
import { generateIdentity, type PeerIdentity } from '../src/mesh/identity'
import { DEFAULT_LANES, isLaneMsg, LANE_MAX_FAILURES, LANE_START_MS, laneSample, peerLinkRates, type LaneSample } from '../src/mesh/lanes'
import { Mesh } from '../src/mesh/mesh'
import { Uplink } from '../src/net/uplink'
import { encodeFragment, NO_REF } from '../src/proto/framing'
import { RelayNode } from '../src/relay/relayNode'
import { uplinkIsFull } from '../src/session/capacity'
import { lanesFrom } from '../src/ui/route'
import { advance, installClock, settle, uninstallClock, until } from './fakes/clock'
import { FakeNetwork, type FakeConn, type FakeNetworkOptions } from './fakes/network'

interface Lobby {
  net: FakeNetwork
  ids: PeerIdentity[]
  meshes: Mesh<FakeConn>[]
}

function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

/**
 * Peers with the given lane settings (undefined: the default), sorted by id so peer 0 has the
 * lowest id (it offers every lane). Peer 0 owns the lobby.
 */
async function makeLobby(lanes: (number | undefined)[], net = new FakeNetwork({ delayMs: 5 })): Promise<Lobby> {
  const ids = (await Promise.all(lanes.map(async () => (await generateIdentity()).identity))).sort((a, b) => (a.id < b.id ? -1 : 1))
  const meshes = ids.map(
    (identity, i) =>
      new Mesh({
        joinCode: 'lanes-lobby',
        identity,
        ownerId: ids[0].id,
        name: `p${i}`,
        iceServers: [],
        lanes: lanes[i],
        connect: net.factory(identity.id),
        connectLane: net.laneFactory(identity.id),
        rendezvous: net.rendezvousFor(identity.id),
        storage: memoryStore(),
      }),
  )
  return { net, ids, meshes }
}

function meshed(group: Mesh<FakeConn>[]): boolean {
  return group.every((m) => group.every((o) => o === m || (!!m.member(o.selfId) && !!m.linkFor(o.selfId))))
}

async function startAll(lobby: Lobby): Promise<void> {
  for (const m of lobby.meshes) await m.start()
  await until(() => meshed(lobby.meshes), 15_000, 'full mesh')
}

/** Lane signaling `id` sent, on any of its connections. */
function laneMsgsBy(net: FakeNetwork, id: string) {
  return net.conns.filter((c) => c.localId === id).flatMap((c) => c.sent.filter((m) => m.t.startsWith('lane-')))
}

beforeEach(() => installClock())
afterEach(() => uninstallClock())

describe('lane signaling', () => {
  it('opens N-1 lanes per pair by default, offered by the lower id', async () => {
    const lobby = await makeLobby([undefined, undefined, undefined])
    await startAll(lobby)
    const [m0, m1, m2] = lobby.meshes
    await until(() => lobby.meshes.every((m) => lobby.meshes.every((o) => o === m || m.laneCount(o.selfId) === DEFAULT_LANES)), 10_000, 'lanes open')
    // One lane per pair, both ends: 3 pairs × 2 ends.
    expect(lobby.net.lanes.filter((l) => l.state === 'open')).toHaveLength(6)
    // Offers only ever go from the lower id to the higher one (ids are sorted: m0 < m1 < m2).
    const offerers = lobby.meshes.filter((m) => laneMsgsBy(lobby.net, m.selfId).some((x) => x.t === 'lane-offer')).map((m) => m.selfId)
    expect(offerers.sort()).toEqual([m0.selfId, m1.selfId].sort())
    expect(laneMsgsBy(lobby.net, m2.selfId).every((x) => x.t === 'lane-answer')).toBe(true)
  })

  it('opens three lanes with lanes=4 on both sides, and waits for the mesh link first', async () => {
    const lobby = await makeLobby([4, 4])
    const [a, b] = lobby.meshes
    await a.start()
    await b.start()
    // No lane before the mesh link opened (lanes never ride on the rendezvous).
    while (!a.linkFor(b.selfId)) {
      expect(lobby.net.lanes).toHaveLength(0)
      await advance(10)
    }
    await advance(LANE_START_MS - 100)
    expect(lobby.net.lanes).toHaveLength(0)
    await until(() => a.laneCount(b.selfId) === 4 && b.laneCount(a.selfId) === 4, 5000, 'lanes open')
    expect(lobby.net.openLanes(a.selfId, b.selfId)).toHaveLength(3)
    expect(lobby.net.openLanes(b.selfId, a.selfId)).toHaveLength(3)
  })

  it('makes no lanes with lanes=1', async () => {
    const lobby = await makeLobby([1, 1])
    await startAll(lobby)
    await advance(20_000)
    expect(lobby.net.lanes).toHaveLength(0)
    expect(laneMsgsBy(lobby.net, lobby.ids[0].id)).toHaveLength(0)
    const [a, b] = lobby.meshes
    expect(a.laneCount(b.selfId)).toBe(1)
    expect(a.mediaLinkFor(b.selfId, 1)).toBe(a.linkFor(b.selfId))
  })

  it('uses the smaller setting of the pair (an answerer with lanes=1 declines, never retried)', async () => {
    const lobby = await makeLobby([4, 1])
    await startAll(lobby)
    await advance(60_000)
    const [a, b] = lobby.meshes
    expect(a.laneCount(b.selfId)).toBe(1)
    // Three offers (lanes 1..3), three declines, nothing more.
    expect(lobby.net.lanes.filter((l) => l.localId === a.selfId)).toHaveLength(3)
    expect(lobby.net.lanes.filter((l) => l.localId === b.selfId)).toHaveLength(0)
    expect(laneMsgsBy(lobby.net, b.selfId)).toEqual([1, 2, 3].map((i) => ({ t: 'lane-close', i, d: true })))
    // Declined slots don't reserve stripes: everything goes over the mesh link.
    for (let s = 0; s < 4; s++) expect(a.mediaLinkFor(b.selfId, s)).toBe(a.linkFor(b.selfId))

    // An offerer with fewer lanes than the answerer: the offerer's setting wins.
    const two = await makeLobby([2, 4])
    await startAll(two)
    await until(() => two.meshes[1].laneCount(two.meshes[0].selfId) === 2, 5000, 'lane open')
    await advance(5000)
    expect(two.meshes[1].laneCount(two.meshes[0].selfId)).toBe(2)
  })

  it('skips lanes when the mesh link is relayed through TURN', async () => {
    const lobby = await makeLobby([4, 4])
    lobby.net.setRelayed(lobby.ids[0].id, lobby.ids[1].id)
    await startAll(lobby)
    await advance(10_000)
    expect(lobby.net.lanes).toHaveLength(0)
    expect(lobby.meshes[0].lanes.relayed(lobby.ids[1].id)).toBe(true)
  })

  it('validates lane messages', () => {
    expect(isLaneMsg({ t: 'lane-offer', i: 1, sdp: 'x' })).toBe(true)
    expect(isLaneMsg({ t: 'lane-close', i: 3, d: true })).toBe(true)
    expect(isLaneMsg({ t: 'lane-offer', i: 0, sdp: 'x' })).toBe(false) // lane 0 is the mesh link
    expect(isLaneMsg({ t: 'lane-offer', i: 4, sdp: 'x' })).toBe(false)
    expect(isLaneMsg({ t: 'lane-offer', i: 1.5, sdp: 'x' })).toBe(false)
    expect(isLaneMsg({ t: 'lane-answer', i: 1 })).toBe(false)
    expect(isLaneMsg({ t: 'lane-answer', i: 1, sdp: 'x'.repeat(100_000) })).toBe(false)
    expect(isLaneMsg({ t: 'lane-close', i: 1, d: 'yes' })).toBe(false)
    expect(isLaneMsg(null)).toBe(false)
  })

  it('ignores lane offers from the higher id, and replies to bogus ones without opening lanes', async () => {
    const lobby = await makeLobby([4, 4])
    await startAll(lobby)
    await until(() => lobby.meshes[0].laneCount(lobby.ids[1].id) === 4, 5000, 'lanes open')
    const before = lobby.net.lanes.length
    // The higher id pretends to offer: the lower id declines rather than answering.
    lobby.net.inject(lobby.ids[1].id, lobby.ids[0].id, { t: 'lane-offer', i: 1, sdp: 'bogus' })
    lobby.net.inject(lobby.ids[1].id, lobby.ids[0].id, { t: 'lane-offer', i: 9, sdp: 'bogus' })
    await advance(100)
    expect(lobby.net.lanes.length).toBe(before)
    expect(lobby.meshes[0].laneCount(lobby.ids[1].id)).toBe(4)
  })
})

describe('stripe to lane mapping', () => {
  it('spreads stripes over the lanes, stably, falling back to the mesh link while a lane is down', async () => {
    const lobby = await makeLobby([3, 3])
    await startAll(lobby)
    const [a, b] = lobby.meshes
    await until(() => a.laneCount(b.selfId) === 3, 5000, 'lanes open')
    const primary = a.linkFor(b.selfId)!
    const [l1, l2] = lobby.net.openLanes(a.selfId, b.selfId).sort((x, y) => x.index - y.index)
    expect([0, 1, 2, 3, 4, 5].map((s) => a.mediaLinkFor(b.selfId, s))).toEqual([primary, l1, l2, primary, l1, l2])

    // Lane 1 fails: its stripes fall back to the mesh link, lane 2 keeps its own.
    l1.fail()
    await advance(10)
    expect(a.laneCount(b.selfId)).toBe(2)
    expect([0, 1, 2, 3].map((s) => a.mediaLinkFor(b.selfId, s))).toEqual([primary, primary, l2, primary])
    // It is re-opened after a backoff, and takes its stripes back.
    await until(() => a.laneCount(b.selfId) === 3, 20_000, 'lane re-opened')
    const again = lobby.net.openLanes(a.selfId, b.selfId).find((l) => l.index === 1)!
    expect(again).not.toBe(l1)
    expect([1, 2].map((s) => a.mediaLinkFor(b.selfId, s))).toEqual([again, l2])
    // The answering side maps the same way.
    await until(() => b.laneCount(a.selfId) === 3, 1000, 'answerer lanes')
  })

  it('gives up on a pair whose lanes keep failing, after a few attempts with backoff', async () => {
    const lobby = await makeLobby([2, 2])
    lobby.net.blockLanes(lobby.ids[0].id, lobby.ids[1].id)
    await startAll(lobby)
    const [a, b] = lobby.meshes
    await advance(5 * 60_000)
    expect(a.laneCount(b.selfId)).toBe(1)
    const made = lobby.net.lanes.filter((l) => l.localId === a.selfId).length
    expect(made).toBe(LANE_MAX_FAILURES)
    expect(lobby.net.lanes.every((l) => l.state === 'failed' || l.state === 'closed')).toBe(true)
    // Given up: the slot no longer reserves stripes.
    expect(a.mediaLinkFor(b.selfId, 1)).toBe(a.linkFor(b.selfId))
  })
})

describe('lane lifetime', () => {
  it('closes a peer’s lanes when it leaves', async () => {
    const lobby = await makeLobby([2, 2, 2])
    await startAll(lobby)
    await until(() => lobby.net.lanes.filter((l) => l.state === 'open').length === 6, 5000, 'lanes open')
    const leaver = lobby.meshes[2]
    await leaver.leave()
    await advance(1000)
    const touching = lobby.net.lanes.filter((l) => l.localId === leaver.selfId || l.remoteId === leaver.selfId)
    expect(touching.length).toBe(4)
    expect(touching.every((l) => l.state === 'closed')).toBe(true)
    // The others keep theirs.
    expect(lobby.meshes[0].laneCount(lobby.meshes[1].selfId)).toBe(2)
  })

  it('closes a kicked peer’s lanes', async () => {
    const lobby = await makeLobby([2, 2, 2])
    await startAll(lobby)
    await until(() => lobby.net.lanes.filter((l) => l.state === 'open').length === 6, 5000, 'lanes open')
    const kicked = lobby.ids[2]
    await lobby.meshes[0].updateAuth((doc) => ban(doc, kicked.pubKey))
    await until(() => lobby.net.lanes.filter((l) => l.remoteId === kicked.id || l.localId === kicked.id).every((l) => l.state === 'closed'), 5000, 'kicked lanes closed')
    expect(lobby.meshes[0].laneCount(kicked.id)).toBe(0)
    expect(lobby.meshes[0].laneCount(lobby.ids[1].id)).toBe(2)
  })

  it('reopens lanes after the mesh link reconnects', async () => {
    const lobby = await makeLobby([2, 2])
    await startAll(lobby)
    const [a, b] = lobby.meshes
    await until(() => a.laneCount(b.selfId) === 2, 5000, 'lanes open')
    const first = lobby.net.openLanes(a.selfId, b.selfId)[0]
    a.resetLink(b.selfId)
    await settle()
    expect(first.state).toBe('closed')
    await until(() => a.laneCount(b.selfId) === 2 && b.laneCount(a.selfId) === 2, 20_000, 'lanes reopened')
    expect(lobby.net.lanes.filter((l) => l.localId === a.selfId)).toHaveLength(2)
  })
})

describe('lane congestion accounting', () => {
  const sample = (peer: string, congested: boolean): LaneSample => ({ peer, drops: congested ? 10 : 0, queueSum: congested ? 2000 : 100, queueN: 10, congested })

  it('counts a peer congested only when most of its lanes are', () => {
    const one = peerLinkRates([sample('a', true), sample('a', false)])
    expect(one.get('a')).toEqual({ drops: 10, queueMs: 105, congested: false })
    expect(peerLinkRates([sample('a', true), sample('a', true)]).get('a')?.congested).toBe(true)
    expect(peerLinkRates([sample('a', true)]).get('a')?.congested).toBe(true)
    expect(peerLinkRates([sample('a', true), sample('a', true), sample('a', false), sample('a', false)]).get('a')?.congested).toBe(false)
  })

  it('counts time in the data channel’s send buffer as queueing', () => {
    const limits = { dropsPerS: 2, queueMs: 400 }
    // 2 s window, 500 KB sent (2 Mbps), 20 ms average in the uplink queue, 100 fragments.
    const d = { sentItems: 100, sentBytes: 500_000, drops: 0, queueSum: 2000, queueN: 100 }
    const empty = laneSample('a', d, 0, 2, limits)!
    expect(empty.queueSum / empty.queueN).toBeCloseTo(20)
    expect(empty.congested).toBe(false)
    // 128 KB buffered at 2 Mbps is ~524 ms more: congested, though the uplink queue is short.
    const backed = laneSample('a', d, 128 * 1024, 2, limits)!
    expect(backed.queueSum / backed.queueN).toBeCloseTo(20 + (128 * 1024 * 8) / 2000)
    expect(backed.congested).toBe(true)
    // Nothing sent or dropped: no sample.
    expect(laneSample('a', { sentItems: 0, sentBytes: 0, drops: 0, queueSum: 0, queueN: 0 }, 0, 2, limits)).toBeNull()
    // Per lane, then per peer: one backed-up lane of two is not the peer.
    expect(peerLinkRates([backed, empty]).get('a')?.congested).toBe(false)
  })

  it('does not call the uplink full when one lane of a single peer backs up', () => {
    const rates = (xs: LaneSample[], pathQueued: boolean | null) => [...peerLinkRates(xs).values()].map((r) => ({ ...r, drops: 3, pathQueued }))
    // One of two lanes at its connection's ceiling: not the uplink, even with a queueing path.
    expect(uplinkIsFull(rates([sample('a', true), sample('a', false)], true))).toBeNull()
    // Both lanes backed up with a flat path RTT: the connections' own ceilings.
    expect(uplinkIsFull(rates([sample('a', true), sample('a', true)], false))).toBeNull()
    // Both backed up and the path RTT inflated: the path is full.
    expect(uplinkIsFull(rates([sample('a', true), sample('a', true)], true))).toEqual({ congested: 1, active: 1, signal: 'rtt' })
  })
})

describe('lane throughput', () => {
  /** A 2-peer lobby on connections capped at `rate` bytes/s; returns bytes/s delivered over 3 s. */
  async function measure(lanes: number, rate: number): Promise<number> {
    const net = new FakeNetwork({ delayMs: 5, connRateBytesPerS: rate } satisfies FakeNetworkOptions)
    const lobby = await makeLobby([lanes, lanes], net)
    await startAll(lobby)
    const [a, b] = lobby.meshes
    await until(() => a.laneCount(b.selfId) === lanes && b.laneCount(a.selfId) === lanes, 5000, 'lanes open')
    // The sender: an uplink and a relay forwarding k+m = 4 stripes to b over its lanes.
    const uplink = new Uplink()
    const relay = new RelayNode(uplink, (id, stripe) => a.mediaLinkFor(id, stripe))
    a.onBufferLow = () => uplink.kick()
    for (let s = 0; s < 4; s++) relay.addChild(1, s, b.selfId)
    let received = 0
    let counting = false
    b.onMedia = (data) => {
      if (counting) received += data.byteLength
    }
    let seq = 0
    const frag = (stripe: number) =>
      encodeFragment(
        {
          channel: 1,
          key: seq === 0,
          audio: false,
          replay: false,
          layer: 0,
          epoch: 1,
          frameSeq: seq,
          gopId: 0,
          refSeq: seq === 0 ? NO_REF : seq - 1,
          captureTime: Date.now(),
          k: 3,
          m: 1,
          pieceIdx: stripe,
          stripe,
          frameLen: 1100,
          fragIdx: 0,
          fragCount: 1,
        },
        new Uint8Array(1100),
      )
    // Offered: 4 stripes × 1.2 KB every 10 ms ≈ 480 KB/s, about 4× one connection's cap.
    const tick = () => {
      for (let s = 0; s < 4; s++) relay.inject(frag(s))
      seq++
    }
    const stop = setInterval(tick, 10)
    await advance(1000)
    counting = true
    await advance(3000)
    counting = false
    clearInterval(stop)
    return received / 3
  }

  it('carries about N times one connection’s ceiling over N lanes', async () => {
    const rate = 100_000 // bytes/s per connection
    const one = await measure(1, rate)
    const two = await measure(2, rate)
    const four = await measure(4, rate)
    expect(one).toBeGreaterThan(rate * 0.85)
    expect(one).toBeLessThan(rate * 1.1)
    expect(two / one).toBeGreaterThan(1.8)
    expect(two / one).toBeLessThan(2.2)
    expect(four / one).toBeGreaterThan(3.5)
  })
})

describe('lanes flag', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('parses lanes=N from the hash or page query, 1..4, default 2', () => {
    vi.stubGlobal('location', { search: '' })
    const p = (q: string) => lanesFrom(new URLSearchParams(q))
    expect(p('')).toBe(2)
    expect(p('lanes=1')).toBe(1)
    expect(p('lanes=4')).toBe(4)
    expect(p('lanes=9')).toBe(4)
    expect(p('lanes=0')).toBe(1)
    expect(p('lanes=2.7')).toBe(2)
    expect(p('lanes=abc')).toBe(2)
    expect(p('lanes=')).toBe(2)
    vi.stubGlobal('location', { search: '?lanes=3' })
    expect(p('')).toBe(3)
    expect(p('lanes=1')).toBe(1) // the hash query wins
  })
})
