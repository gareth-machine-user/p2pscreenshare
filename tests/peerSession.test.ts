// PeerSession on the in-memory network (tests/fakes/) under fake time: whole sessions, their mesh
// on FakeConns. Nothing here captures or encodes (no WebCodecs in node): a presenter is a real
// ChannelPublisher fed hand-made frames, standing in for PublishedStream.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateIdentity, type PeerIdentity } from '../src/mesh/identity'
import type { ChannelAnnouncement } from '../src/mesh/records'
import { NO_REF } from '../src/proto/framing'
import { ChannelPublisher } from '../src/session/channelPublisher'
import { PeerSession, type PeerSessionOptions } from '../src/session/peerSession'
import type { PublishedStream } from '../src/session/publishedStream'
import { advance, installClock, uninstallClock, until } from './fakes/clock'
import { FakeNetwork } from './fakes/network'

interface Lobby {
  net: FakeNetwork
  ids: PeerIdentity[]
  sessions: PeerSession[]
}

function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

/** `n` sessions, not started; session 0 owns the lobby. */
async function makeSessions(n: number): Promise<Lobby> {
  const net = new FakeNetwork({ delayMs: 5 })
  const ids = await Promise.all(Array.from({ length: n }, async () => (await generateIdentity()).identity))
  const sessions = ids.map(
    (identity, i) =>
      new PeerSession({
        joinCode: 'test-lobby',
        identity,
        ownerId: ids[0].id,
        name: `p${i}`,
        iceServers: [],
        capKbps: null,
        // Typed for PeerConn, which FakeConn implements (the factories' types are invariant in it).
        meshDeps: {
          connect: net.factory(identity.id),
          connectLane: net.laneFactory(identity.id),
          rendezvous: net.rendezvousFor(identity.id),
          storage: memoryStore(),
        } as unknown as PeerSessionOptions['meshDeps'],
      }),
  )
  return { net, ids, sessions }
}

/** `n` sessions, started and meshed; session 0 owns the lobby. */
async function makeLobby(n: number): Promise<Lobby> {
  const { net, ids, sessions } = await makeSessions(n)
  for (const s of sessions) await s.start()
  await until(() => sessions.every((s) => sessions.every((o) => o === s || !!s.mesh.linkFor(o.selfId))), 15_000, 'full mesh')
  return { net, ids, sessions }
}

/** Ctl messages of type `t` that `from` sent to `to`. */
function sent(net: FakeNetwork, from: string, to: string, t: string): unknown[] {
  return net.conns
    .filter((c) => c.localId === from && c.remoteId === to)
    .flatMap((c) => c.sent)
    .filter((m) => m.t === 'app' && (m.m as { t?: string } | undefined)?.t === t)
}

/** Makes `s` present a channel of k + m stripes without capture or encoding. */
function present(s: PeerSession, k = 2, m = 1): ChannelPublisher {
  const cp = new ChannelPublisher(0x1234, 'full', k, m, 1000, false, s, () => {})
  const stream = {
    channels: [cp],
    full: cp,
    ceilingKbps: 1000,
    stop: () => cp.stop(),
    sampleEncoder: () => null,
    adaptBitrate: (kbps: number) => void (cp.kbps = kbps),
  }
  s.publishing = stream as unknown as PublishedStream
  // Announces the channel with what decoders configure from.
  cp.setStream({ epoch: 1, codec: 'vp8', codedWidth: 16, codedHeight: 16 })
  return cp
}

/** A fake channel announcement in the owner's record (the owner may always publish). */
function announceFake(s: PeerSession, id = 0x77): ChannelAnnouncement {
  const ann: ChannelAnnouncement = { id, kind: 'full', k: 2, m: 1, kbps: 1000, stripeKbps: 500, stream: null, deficit: 0, startedAt: 1 }
  s.mesh.updateRecord({ channels: [ann] })
  return ann
}

let decodes = 0
let lobby: Lobby | null = null

beforeEach(() => {
  installClock()
  decodes = 0
  // The player schedules rendering on animation frames, and decodes with WebCodecs.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'unconfigured'
      decodeQueueSize = 0
      configure() {
        this.state = 'configured'
      }
      decode() {
        decodes++
      }
      close() {
        this.state = 'closed'
      }
    },
  )
  vi.stubGlobal('EncodedVideoChunk', class {})
})

afterEach(async () => {
  for (const s of lobby?.sessions ?? []) await s.leave()
  lobby = null
  vi.unstubAllGlobals()
  uninstallClock()
})

describe('PeerSession (in-memory network)', () => {
  it('watches no channel once it has left, even with a reconcile pending', async () => {
    lobby = await makeLobby(2)
    const [owner, viewer] = lobby.sessions
    announceFake(owner)
    await until(() => viewer.subs.size === 1, 5000, 'viewer subscribed')
    // A reconcile is pending when it leaves.
    viewer.setQuality('full')
    await viewer.leave()
    expect(viewer.subs.size).toBe(0)
    // Records keep arriving until the links close.
    owner.mesh.updateRecord({ capacityKbps: 1234 })
    await advance(3000)
    expect(viewer.subs.size).toBe(0)
  })

  it('stops watching a channel’s topology when the channel ends, whatever sign its id came with', async () => {
    lobby = await makeLobby(2)
    const [owner, viewer] = lobby.sessions
    const ann = announceFake(owner, 0x8000_0077)
    await until(() => viewer.liveChannels().length === 1, 5000, 'channel seen')
    const watching = (viewer as unknown as { topoWatching: Set<number> }).topoWatching
    viewer.watchTopology(ann.id | 0, true) // the same id, as a signed int32
    viewer.watchTopology(ann.id, false)
    expect(watching.size).toBe(0)
    viewer.watchTopology(ann.id, true)
    expect(sent(lobby.net, viewer.selfId, owner.selfId, 'topo-req')).toHaveLength(3)
    owner.mesh.updateRecord({ channels: [] })
    await until(() => viewer.liveChannels().length === 0, 5000, 'channel ended')
    expect(watching.size).toBe(0)
  })

  it("setPolicy('open' | 'closed') makes one auth update, answering pending requests in it", async () => {
    lobby = await makeLobby(3)
    const [owner, a, b] = lobby.sessions
    a.requestPublish()
    await until(() => owner.requests.has(a.selfId), 3000, 'request arrives')
    const updates = vi.spyOn(owner.mesh, 'updateAuth')
    await owner.setPolicy('open')
    expect(updates).toHaveBeenCalledTimes(1)
    expect(owner.policy).toBe('open')
    expect(owner.requests.size).toBe(0)
    await until(() => a.requestState === 'granted', 3000, 'request granted')

    await owner.setPolicy('closed')
    expect(updates).toHaveBeenCalledTimes(2)
    expect(owner.policy).toBe('closed')
    await until(() => b.policy === 'closed', 3000, 'policy reaches b')
    b.requestPublish()
    await until(() => b.requestState === 'denied', 3000, 'request denied')
  })

  it('cancelling a request withdraws it at the owner', async () => {
    lobby = await makeLobby(2)
    const [owner, member] = lobby.sessions
    member.requestPublish()
    expect(member.requestState).toBe('waiting')
    await until(() => owner.requests.has(member.selfId), 3000, 'request arrives')
    member.cancelRequest()
    expect(member.requestState).toBe('idle')
    expect(sent(lobby.net, member.selfId, owner.selfId, 'publish-cancel')).toHaveLength(1)
    await until(() => !owner.requests.has(member.selfId), 3000, 'request withdrawn')
  })

  it("measures the uplink's first window from construction", async () => {
    lobby = await makeSessions(1)
    const [s] = lobby.sessions
    const stats = s.uplink.stats
    await advance(1000)
    await s.start()
    stats.sentBytes = 75_000
    stats.sentItems = 30
    stats.droppedItems = 10
    stats.queueDelaySum = 600
    stats.queueDelayN = 20
    // The first sample, 2 s after start: 3 s after construction.
    await advance(2000)
    expect(s.uplinkSample()).toEqual({ kbps: (75_000 * 8) / 1000 / 3, dropRate: 0.25 })
    expect(s.uplinkRates()).toMatchObject({ kbps: 200, queueMs: 30 })
    stats.sentBytes += 50_000
    await advance(2000)
    expect(s.uplinkSample()).toEqual({ kbps: 200, dropRate: 0 })
    expect(s.uplinkRates()).toMatchObject({ kbps: 200, queueMs: 0 })
  })

  it('a viewer joins a presenter’s channel and decodes its frames', async () => {
    lobby = await makeLobby(2)
    const [presenter, viewer] = lobby.sessions
    const cp = present(presenter)
    await until(() => viewer.subs.has(cp.id), 5000, 'viewer subscribed')
    const sub = viewer.subs.get(cp.id)!
    await until(() => sub.parents.every((p) => p === presenter.selfId), 5000, 'parents set')
    expect(viewer.selected).toBe(presenter.selfId)
    expect(presenter.debugPublisher().peers).toBe(1)
    let seq = 0
    const emit = (key: boolean) =>
      cp.emit({ epoch: 1, seq: seq++, gopId: 1, refSeq: key ? NO_REF : seq - 1, key, layer: 0, audio: false, captureTime: Date.now(), data: new Uint8Array(3000).fill(seq) })
    emit(true)
    for (let i = 0; i < 5; i++) {
      await advance(33)
      emit(false)
    }
    await until(() => decodes > 0, 3000, 'frames decoded')
    // The bitrate control ran on the uplink windows meanwhile.
    await advance(2000)
    expect(presenter.rateStatus()).toMatchObject({ chosenKbps: 1000, stalledLanes: 0 })
    expect(viewer.rateStatus()).toBeNull()
  })
})
