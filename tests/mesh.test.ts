// Multi-peer Mesh tests on an in-memory network (tests/fakes/) under fake time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ban } from '../src/mesh/auth'
import { seal, type Envelope } from '../src/mesh/envelope'
import { generateIdentity, type PeerIdentity } from '../src/mesh/identity'
import { Mesh } from '../src/mesh/mesh'
import { GONE_MS, type MemberRecord } from '../src/mesh/records'
import { advance, installClock, settle, uninstallClock, until } from './fakes/clock'
import { FakeNetwork, type FakeConn } from './fakes/network'

interface Lobby {
  net: FakeNetwork
  ids: PeerIdentity[]
  meshes: Mesh<FakeConn>[]
}

function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

/** `n` peers; peer 0 owns the lobby. None is started yet. */
async function makeLobby(n: number): Promise<Lobby> {
  const net = new FakeNetwork({ delayMs: 5 })
  const ids = await Promise.all(Array.from({ length: n }, async () => (await generateIdentity()).identity))
  const meshes = ids.map(
    (identity, i) =>
      new Mesh({
        joinCode: 'test-lobby',
        identity,
        ownerId: ids[0].id,
        name: `p${i}`,
        iceServers: [],
        connect: net.factory(identity.id),
        connectLane: net.laneFactory(identity.id),
        rendezvous: net.rendezvousFor(identity.id),
        storage: memoryStore(),
      }),
  )
  return { net, ids, meshes }
}

/** Whether every peer in `group` knows, and has an open link to, every other one. */
function meshed(group: Mesh<FakeConn>[]): boolean {
  return group.every((m) => group.every((o) => o === m || (!!m.member(o.selfId) && !!m.linkFor(o.selfId))))
}

/** Starts the owner, then the rest, and waits until all are fully meshed. */
async function startAll(lobby: Lobby, limitMs = 15_000): Promise<number> {
  for (const m of lobby.meshes) await m.start()
  return until(() => meshed(lobby.meshes), limitMs, 'full mesh')
}

function chatEnv(identity: PeerIdentity, text: string, at = Date.now()): Promise<Envelope> {
  return seal(identity, { type: 'chat', id: crypto.randomUUID(), from: identity.id, name: 'x', text, at })
}

/** Every ctl message a peer sent, on any of its connections. */
function sentBy(net: FakeNetwork, id: string): { t: string; [k: string]: unknown }[] {
  return net.conns.filter((c) => c.localId === id).flatMap((c) => c.sent)
}

beforeEach(() => installClock())
afterEach(() => uninstallClock())

describe('mesh (in-memory network)', () => {
  it('five peers find each other and converge on every record', async () => {
    const lobby = await makeLobby(5)
    const took = await startAll(lobby)
    expect(took).toBeLessThan(10_000)
    // Each peer's latest record reaches everyone within a heartbeat.
    lobby.meshes[3].updateRecord({ capacityKbps: 1234 })
    await until(() => lobby.meshes.every((m) => m.member(lobby.ids[3].id)?.capacityKbps === 1234), 3000, 'record update')
    for (const m of lobby.meshes) expect(m.memberCount).toBe(5)
  })

  it('declares a silent peer gone within the gone timeout', async () => {
    const lobby = await makeLobby(4)
    await startAll(lobby)
    const victim = lobby.ids[3].id
    const others = lobby.meshes.slice(0, 3)
    lobby.net.isolate(victim)
    await advance(3000)
    expect(others.every((m) => m.member(victim))).toBe(true)
    const took = await until(() => others.every((m) => !m.member(victim)), GONE_MS + 2000, 'victim gone')
    expect(took + 3000).toBeLessThanOrEqual(GONE_MS + 1500)
    expect(others.every((m) => !m.linkFor(victim))).toBe(true)
    // The others are still meshed with each other.
    expect(meshed(others)).toBe(true)
  })

  it('an unsigned digest claiming a newer version does not keep a silent peer alive', async () => {
    const lobby = await makeLobby(4)
    await startAll(lobby)
    const [p0, p1] = lobby.ids
    const victim = lobby.ids[3].id
    lobby.net.isolate(victim)
    const start = performance.now()
    // p1 keeps telling p0 there is a newer record of the victim.
    while (lobby.meshes[0].member(victim)) {
      expect(performance.now() - start).toBeLessThan(GONE_MS + 1500)
      lobby.net.inject(p1.id, p0.id, { t: 'digest', d: { [victim]: Date.now() + 1e9 }, a: 0 })
      await advance(200)
    }
  })

  it('drops a validly signed but malformed record without storing or forwarding it', async () => {
    const lobby = await makeLobby(4)
    await startAll(lobby)
    const [p0, p1] = lobby.ids
    const good = lobby.meshes[1].record
    const bad = { ...good, version: good.version + 1e6, unreachable: null } as unknown as MemberRecord
    const env = await seal(p1, bad)
    expect(lobby.net.inject(p1.id, p0.id, { t: 'rec', env })).toBe(true)
    expect(lobby.net.inject(p1.id, p0.id, { t: 'recs', envs: [env] })).toBe(true)
    await advance(5000)
    for (const m of lobby.meshes.slice(0, 1).concat(lobby.meshes.slice(2))) {
      const r = m.member(p1.id)!
      expect(r.version).toBeLessThan(bad.version)
      expect(Array.isArray(r.unreachable)).toBe(true)
    }
    expect(sentBy(lobby.net, p0.id).some((m) => JSON.stringify(m).includes(env.s))).toBe(false)
    expect(meshed(lobby.meshes)).toBe(true)
  })

  it('a joiner gets the full chat history, even when one author wrote most of it', async () => {
    const lobby = await makeLobby(5)
    const early = lobby.meshes.slice(0, 4)
    for (const m of early) await m.start()
    await until(() => meshed(early), 15_000, 'mesh of four')
    const author = lobby.meshes[1]
    for (let i = 0; i < 5; i++) expect(author.sendChat(`a${i}`)).toBe(true)
    expect(author.sendChat('too fast')).toBe(false)
    await advance(5100)
    for (let i = 5; i < 8; i++) expect(author.sendChat(`a${i}`)).toBe(true)
    expect(lobby.meshes[2].sendChat('b0')).toBe(true)
    await advance(1000)
    for (const m of early) expect(m.chat).toHaveLength(9)

    const joiner = lobby.meshes[4]
    await joiner.start()
    await until(() => meshed(lobby.meshes), 15_000, 'joiner meshed')
    await advance(500)
    expect(joiner.chat.map((c) => c.text).sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'b0'])
  })

  it('rate limits live chat per author', async () => {
    const lobby = await makeLobby(3)
    await startAll(lobby)
    const [p0, p1] = lobby.ids
    const envs = await Promise.all(Array.from({ length: 8 }, (_, i) => chatEnv(p1, `flood${i}`)))
    for (const env of envs) lobby.net.inject(p1.id, p0.id, { t: 'chat', env })
    await advance(100)
    expect(lobby.meshes[0].chat.filter((c) => c.from === p1.id)).toHaveLength(5)
    // The window slides: later messages get through again.
    await advance(5000)
    lobby.net.inject(p1.id, p0.id, { t: 'chat', env: await chatEnv(p1, 'later') })
    await advance(100)
    expect(lobby.meshes[0].chat.map((c) => c.text)).toContain('later')
  })

  it('an owner kick closes links to the peer, drops its chat, and keeps it out', async () => {
    const lobby = await makeLobby(4)
    await startAll(lobby)
    const [owner, , , kicked] = lobby.meshes
    const kickedId = lobby.ids[3].id
    const others = lobby.meshes.slice(0, 3)
    await owner.updateAuth((doc) => ban(doc, lobby.ids[3].pubKey))
    await until(() => others.every((m) => !m.linkFor(kickedId)), 2000, 'links closed')

    // Its chat is dropped, whether sent itself or forwarded by someone else.
    kicked.sendChat('let me back')
    lobby.net.inject(lobby.ids[1].id, lobby.ids[2].id, { t: 'chat', env: await chatEnv(lobby.ids[3], 'forwarded') })
    await advance(1000)
    for (const m of others) expect(m.chat.some((c) => c.from === kickedId)).toBe(false)

    // It never gets back in, though it keeps knocking (as a seeker and through its own door).
    await advance(30_000)
    for (const m of others) {
      expect(m.linkFor(kickedId)).toBeUndefined()
      expect(m.member(kickedId)).toBeUndefined()
    }
    expect(meshed(others)).toBe(true)
  })

  it("a kicked peer's snapshot is ignored and its link closed at once", async () => {
    const lobby = await makeLobby(4)
    await startAll(lobby)
    const [p0, p1, p2, p3] = lobby.ids
    const m1 = lobby.meshes[1]
    await lobby.meshes[0].updateAuth((doc) => ban(doc, p3.pubKey))
    await until(() => m1.isBannedPeer(p3.id), 1000, 'ban known')
    expect(m1.linkFor(p3.id)).toBeDefined() // closing waits for the news to spread
    const chat = [await chatEnv(p3, 'from kicked'), await chatEnv(p2, 'relayed by kicked')]
    expect(lobby.net.inject(p3.id, p1.id, { t: 'snapshot', recs: [], chat })).toBe(true)
    await settle()
    expect(m1.linkFor(p3.id)).toBeUndefined()
    expect(m1.chat.map((c) => c.text)).not.toContain('from kicked')
    expect(m1.chat.map((c) => c.text)).not.toContain('relayed by kicked')
    expect(p0).toBeDefined()
  })

  it('a pair that cannot connect stays in the lobby, marked unreachable', async () => {
    const lobby = await makeLobby(4)
    const [, p1, p2] = lobby.ids
    lobby.net.block(p1.id, p2.id)
    for (const m of lobby.meshes) await m.start()
    await until(() => lobby.meshes.every((m) => m.members().length === 3), 15_000, 'all members known')
    // Both ends give up at their connect deadline and say so in their records.
    const [m0, m1, m2, m3] = lobby.meshes
    const marked = () =>
      m1.linkStatus(p2.id) === 'unreachable' && m2.linkStatus(p1.id) === 'unreachable' && m0.unreachablePair(p1.id, p2.id) && m3.unreachablePair(p1.id, p2.id)
    await until(marked, 40_000, 'pair marked unreachable')
    expect(m2.member(p1.id)).toBeDefined()
    expect(m1.member(p2.id)).toBeDefined()
    expect(m3.linked(p1.id, p2.id)).toBe(false)
  })
})
