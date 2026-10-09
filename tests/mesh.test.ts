// Multi-peer Mesh tests on an in-memory network (tests/fakes/) under fake time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ban, emptyAuth, grant } from '../src/mesh/auth'
import { seal, type Envelope } from '../src/mesh/envelope'
import { generateIdentity, peerIdOf, type PeerIdentity } from '../src/mesh/identity'
import { toBase64Url } from '../src/net/lobby'
import { Mesh, type MeshOptions } from '../src/mesh/mesh'
import { CHAT_KEEP, ChatLog } from '../src/mesh/chatLog'
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
async function makeLobby(n: number, extra: (i: number) => Partial<MeshOptions<FakeConn>> = () => ({})): Promise<Lobby> {
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
        ...extra(i),
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

  it('a stalled ctl channel does not drop a peer whose media still arrives', async () => {
    const lobby = await makeLobby(2)
    await startAll(lobby)
    const [owner, viewer] = lobby.meshes
    lobby.net.stallCtl(owner.selfId, viewer.selfId)
    const link = owner.linkFor(viewer.selfId)!
    for (let t = 0; t < GONE_MS * 2; t += 100) {
      link.send(new Uint8Array(100))
      await advance(100)
    }
    expect(viewer.member(owner.selfId)).toBeTruthy()
    expect(viewer.linkFor(owner.selfId)?.isOpen).toBe(true)
    lobby.net.releaseCtl()
    await advance(1000)
    expect(meshed(lobby.meshes)).toBe(true)
  })

  it('a stalled ctl channel does not drop a peer whose connection still receives (pathHeardAt)', async () => {
    const lobby = await makeLobby(2)
    await startAll(lobby)
    const [owner, viewer] = lobby.meshes
    // No media either way, but each side's connection sees the other's acks.
    const wire = (m: Mesh<FakeConn>, other: Mesh<FakeConn>) => (m.pathHeardAt = (id) => (id === other.selfId ? performance.now() - 500 : null))
    wire(owner, viewer)
    wire(viewer, owner)
    lobby.net.stallCtl(owner.selfId, viewer.selfId)
    await advance(GONE_MS * 2)
    expect(owner.member(viewer.selfId)).toBeTruthy()
    expect(viewer.member(owner.selfId)).toBeTruthy()
    expect(owner.linkFor(viewer.selfId)?.isOpen).toBe(true)
    // Nothing on the wire either: gone as before.
    owner.pathHeardAt = () => null
    const took = await until(() => !owner.member(viewer.selfId), GONE_MS + 2000, 'viewer gone')
    expect(took).toBeLessThanOrEqual(GONE_MS + 500)
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

  it('drops chat dated far in the future, so it cannot pin itself over newer messages', async () => {
    const lobby = await makeLobby(3)
    await startAll(lobby)
    const [p0, p1] = lobby.ids
    lobby.net.inject(p1.id, p0.id, { t: 'chat', env: await chatEnv(p1, 'from the future', Date.now() + 10 * 60_000) })
    lobby.net.inject(p1.id, p0.id, { t: 'chat', env: await chatEnv(p1, 'slightly ahead', Date.now() + 30_000) })
    await advance(100)
    const texts = lobby.meshes[0].chat.map((c) => c.text)
    expect(texts).not.toContain('from the future')
    expect(texts).toContain('slightly ahead')
  })

  it('a late message older than the whole log is neither shown nor handed on to joiners', async () => {
    const lobby = await makeLobby(3)
    const [m0, m1, joiner] = lobby.meshes
    await m0.start()
    await m1.start()
    await until(() => meshed([m0, m1]), 15_000, 'pair meshed')
    const [p0, p1] = lobby.ids
    // A full log: 50 messages by 10 authors (5 each, within the per-author rate limit).
    const authors = await Promise.all(Array.from({ length: 10 }, async () => (await generateIdentity()).identity))
    for (const [i, author] of authors.entries()) {
      for (let j = 0; j < 5; j++) lobby.net.inject(p1.id, p0.id, { t: 'chat', env: await chatEnv(author, `m${i}.${j}`) })
    }
    await advance(100)
    expect(m0.chat).toHaveLength(50)
    const shown: string[] = []
    m0.onChat = (m) => shown.push(m.text)
    lobby.net.inject(p1.id, p0.id, { t: 'chat', env: await chatEnv(p1, 'ancient', Date.now() - 3_600_000) })
    await advance(100)
    expect(shown).toEqual([])
    expect(m0.chat.map((c) => c.text)).not.toContain('ancient')

    await joiner.start()
    await until(() => meshed(lobby.meshes), 15_000, 'joiner meshed')
    await advance(500)
    expect(joiner.chat.map((c) => c.text)).toEqual(m0.chat.map((c) => c.text))
  })

  it('concurrent owner decisions build on each other instead of one undoing the other', async () => {
    const lobby = await makeLobby(3)
    await startAll(lobby)
    const [owner] = lobby.meshes
    const [, a, b] = lobby.ids
    const failing = owner.updateAuth(() => {
      throw new Error('bad change')
    })
    await Promise.all([owner.updateAuth((doc) => grant(doc, a.pubKey)), owner.updateAuth((doc) => grant(doc, b.pubKey)), failing.catch(() => {})])
    await expect(failing).rejects.toThrow('bad change')
    expect(owner.auth.grants.map((g) => g.peerKey).sort()).toEqual([a.pubKey, b.pubKey].sort())
  })

  it('of two owner documents arriving together, the newer one decides who is banned', async () => {
    const lobby = await makeLobby(3)
    await startAll(lobby)
    const [owner, other] = lobby.ids
    const m2 = lobby.meshes[2]
    // A key whose peer id isn't cached yet, so the older document takes longer to apply.
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const key = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
    const base = lobby.meshes[0].auth.version
    const older = await seal(owner, { ...emptyAuth(), version: base + 1, banned: [key] })
    const newer = await seal(owner, { ...emptyAuth(), version: base + 2, banned: [] })
    lobby.net.inject(other.id, m2.selfId, { t: 'auth', env: older })
    lobby.net.inject(other.id, m2.selfId, { t: 'auth', env: newer })
    await advance(100)
    expect(m2.auth.version).toBe(base + 2)
    expect(m2.isBannedPeer(await peerIdOf(key))).toBe(false)
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

  it('a link dropped once the peer turns out to be blocked by name is reported closed', async () => {
    // p0 blocks p1 by name, which it only learns from p1's record, after their door link opened.
    const lobby = await makeLobby(2, (i) => (i === 0 ? { block: ['p1'] } : {}))
    const [m0, m1] = lobby.meshes
    const p1 = lobby.ids[1].id
    let opened = 0
    let closed = 0
    m0.onLinkOpen = (id) => void (id === p1 && opened++)
    m0.onLinkClose = (id) => void (id === p1 && closed++)
    await m0.start()
    await m1.start()
    await until(() => !!m0.member(p1) && opened > 0, 15_000, 'p1 known')
    await advance(100)
    expect(m0.linkFor(p1)).toBeUndefined()
    expect(m0.linkStatus(p1)).toBe('unreachable')
    expect(closed).toBe(opened)
  })

  it('chat reaches a peer that marked the sender unreachable, though the sender did not mark it', async () => {
    // p1 refuses p2 (debug block by name), so only p1 lists the pair as unreachable: p2's attempts
    // just go unanswered.
    const lobby = await makeLobby(3, (i) => (i === 1 ? { block: ['p2'] } : {}))
    const [m0, m1, m2] = lobby.meshes
    const [, p1, p2] = lobby.ids
    for (const m of lobby.meshes) await m.start()
    await until(() => m1.record.unreachable.includes(p2.id) && !!m0.linkFor(p1.id) && !!m0.linkFor(p2.id), 30_000, 'p1 marks p2')
    expect(m2.record.unreachable).not.toContain(p1.id)
    expect(m2.sendChat('hello')).toBe(true)
    await advance(500)
    expect(m1.chat.map((c) => c.text)).toContain('hello')
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

  it("a member can't claim an earlier join time later on to take door duty from an older one", async () => {
    const lobby = await makeLobby(5)
    await startAll(lobby)
    await advance(1000)
    // The non-owner with the highest id: not a door (all joined at once, so ties go by id).
    const liar = lobby.meshes.slice(1).reduce((a, b) => (a.selfId > b.selfId ? a : b))
    const honest = lobby.meshes.filter((m) => m !== liar)
    const doors = () => honest.filter((m) => m.isDoor).map((m) => m.selfId).sort()
    const before = doors()
    expect(before).toHaveLength(3)
    liar.updateRecord({ joinedAt: 0 })
    await until(() => honest.every((m) => m.member(liar.selfId)?.joinedAt === 0), 3000, 'claim gossiped')
    await advance(1000)
    expect(doors()).toEqual(before)
  })

  it("a newcomer claiming to have joined long ago doesn't take door duty from older members", async () => {
    const lobby = await makeLobby(5)
    const honest = lobby.meshes.slice(0, 4)
    const liar = lobby.meshes[4]
    for (const m of honest) await m.start()
    await until(() => meshed(honest), 15_000, 'mesh of four')
    await advance(6000)
    const doors = () => honest.filter((m) => m.isDoor).map((m) => m.selfId).sort()
    const before = doors()
    expect(before).toHaveLength(3)
    liar.updateRecord({ joinedAt: 0 })
    await liar.start()
    await until(() => meshed(lobby.meshes), 15_000, 'liar meshed in')
    await advance(1000)
    expect(doors()).toEqual(before)
  })

  it("a later joiner takes a liar's claimed join time, which costs it no door duty: the liar is older anyway", async () => {
    const lobby = await makeLobby(5)
    const [owner, h1, h2, liar, joiner] = lobby.meshes
    for (const m of [owner, h1, h2]) await m.start()
    await until(() => meshed([owner, h1, h2]), 15_000, 'mesh of three')
    await advance(6000)
    liar.updateRecord({ joinedAt: 0 })
    await liar.start()
    await until(() => meshed([owner, h1, h2, liar]), 15_000, 'liar meshed in')
    await advance(6000)
    joiner.updateRecord({ joinedAt: Date.now() })
    await joiner.start()
    await until(() => meshed(lobby.meshes), 15_000, 'joiner meshed in')
    await advance(1000)
    expect(joiner.member(liar.selfId)?.joinedAt).toBe(0)
    expect([h1.isDoor, h2.isDoor, joiner.isDoor]).toEqual([true, true, false])
    // Door duty only asks who is older than this peer, and the liar is: by how much doesn't matter.
    await h1.leave()
    await advance(2000)
    expect([h2.isDoor, joiner.isDoor]).toEqual([true, false])
    await h2.leave()
    await advance(2000)
    expect(joiner.isDoor).toBe(true)
  })

  it('a joiner whose door drops its signaling meshes in through another door', async () => {
    const lobby = await makeLobby(5)
    const [, , , liar, joiner] = lobby.meshes
    const early = lobby.meshes.slice(0, 4)
    for (const m of early) await m.start()
    await until(() => meshed(early), 15_000, 'mesh of four')
    // The liar makes itself a door (its own claim says it is the oldest) and relays nobody's signaling.
    const l = liar as unknown as { onSig: (env: Envelope, to: string, from: string) => Promise<void> }
    const onSig = l.onSig.bind(liar)
    l.onSig = (env, to, from) => (to === liar.selfId ? onSig(env, to, from) : Promise.resolve())
    liar.updateRecord({ joinedAt: 0 })
    await until(() => liar.isDoor, 3000, 'liar a door')
    // The joiner happens to answer the liar's offer first.
    const r = (joiner as unknown as { rendezvous: { shouldAnswer: (id: string) => boolean } }).rendezvous
    const answer = r.shouldAnswer
    let steer = true
    r.shouldAnswer = (id) => (!steer || id === liar.selfId) && answer(id)
    joiner.updateRecord({ joinedAt: Date.now() })
    await joiner.start()
    await until(() => !!joiner.linkFor(liar.selfId), 15_000, 'joiner linked to the liar')
    steer = false
    await until(() => meshed(lobby.meshes), 40_000, 'joiner meshed in')
  })
})

describe('signaling (in-memory network)', () => {
  /** A knock (please offer to me), signed by `from`. */
  function knock(from: PeerIdentity, to: string, at = Date.now(), nonce = crypto.randomUUID()): Promise<Envelope> {
    return seal(from, { type: 'sig', from: from.id, to, kind: 'knock', nonce, at })
  }

  /**
   * Four peers where the pair `lo` < `hi` can't connect (and, if `alsoBlockHi`, nor can p3 and
   * `hi`), settled: both ends have given up on the pair, so only a knock makes `lo` offer again.
   */
  async function blockedPair(alsoBlockHi = false) {
    const lobby = await makeLobby(4)
    const [x, y] = [lobby.ids[1], lobby.ids[2]]
    const [lo, hi] = x.id < y.id ? [x, y] : [y, x]
    const p3 = lobby.ids[3]
    lobby.net.block(lo.id, hi.id)
    if (alsoBlockHi) lobby.net.block(p3.id, hi.id)
    const at = (id: PeerIdentity) => lobby.meshes[lobby.ids.indexOf(id)]
    for (const m of lobby.meshes) await m.start()
    // Every peer has heard (from the records) that the pairs failed.
    const settled = () =>
      lobby.meshes.every((m) => m.members().length === 3 && m.unreachablePair(lo.id, hi.id) && (!alsoBlockHi || m.unreachablePair(p3.id, hi.id))) &&
      !at(lo).conns.has(hi.id)
    await until(settled, 60_000, 'blocked pairs given up')
    // Offers `lo` sent towards `hi` (directly or through relays).
    const offers = () => sentBy(lobby.net, lo.id).filter((m) => m.t === 'sig' && m.to === hi.id)
    /** Hands `lo` a knock through the owner; whether `lo` started an offer because of it. */
    const deliver = async (env: Envelope): Promise<boolean> => {
      const before = offers().length
      expect(lobby.net.inject(lobby.ids[0].id, lo.id, { t: 'sig', to: lo.id, env })).toBe(true)
      await advance(200)
      const offered = offers().length > before
      // Let the attempt fail (the pair is blocked), so the next knock is judged on its own.
      if (offered) await until(() => !at(lo).conns.has(hi.id), 30_000, 'attempt over')
      return offered
    }
    return { lobby, lo, hi, p3, at, offers, deliver }
  }

  it('a replayed knock is refused, a fresh one is not', async () => {
    const { lo, hi, deliver } = await blockedPair()
    const env = await knock(hi, lo.id)
    expect(await deliver(env)).toBe(true)
    expect(await deliver(env)).toBe(false)
    expect(await deliver(await knock(hi, lo.id))).toBe(true)
  })

  it('takes signaling from a clock up to 10 minutes off, refuses older', async () => {
    const { lo, hi, deliver } = await blockedPair()
    const min = 60_000
    expect(await deliver(await knock(hi, lo.id, Date.now() - 11 * min))).toBe(false)
    expect(await deliver(await knock(hi, lo.id, Date.now() + 11 * min))).toBe(false)
    expect(await deliver(await knock(hi, lo.id, Date.now() + 9 * min))).toBe(true)
    expect(await deliver(await knock(hi, lo.id, Date.now() - 9 * min))).toBe(true)
  })

  it('refuses a knock signed by someone other than its named sender', async () => {
    const { lobby, lo, hi, deliver } = await blockedPair()
    const forged = await seal(lobby.ids[3], { type: 'sig', from: hi.id, to: lo.id, kind: 'knock', nonce: 'n', at: Date.now() })
    expect(await deliver(forged)).toBe(false)
  })

  it('routes an offer through a neighbour linked to the addressee, which hands it on', async () => {
    const { lobby, lo, hi, p3, at, offers, deliver } = await blockedPair(true)
    const owner = lobby.ids[0]
    const sigOf = (m: { [k: string]: unknown }) => (m.env as Envelope).s
    const old = new Set(offers().map(sigOf))
    expect(await deliver(await knock(hi, lo.id))).toBe(true)
    const fresh = offers().filter((m) => !old.has(sigOf(m)))
    expect(new Set(fresh.map(sigOf)).size).toBe(1)
    const env = fresh[0].env as Envelope
    const carried = (m: { t: string; [k: string]: unknown }) => m.t === 'sig' && (m.env as Envelope).s === env.s
    // p3 can't reach `hi` either, so only the owner relays.
    const relayedBy = lobby.net.conns.filter((c) => c.localId === lo.id && c.sent.some(carried)).map((c) => c.remoteId)
    expect(relayedBy).toEqual([owner.id])
    expect(at(p3).linkFor(lo.id)).toBeDefined()
    const ownerToHi = lobby.net.conns.filter((c) => c.localId === owner.id && c.remoteId === hi.id).flatMap((c) => c.sent)
    expect(ownerToHi.some(carried)).toBe(true)
    // `hi` answered back the same way.
    const answers = lobby.net.conns.filter((c) => c.localId === hi.id).flatMap((c) => c.sent).filter((m) => m.t === 'sig' && m.to === lo.id)
    expect(answers.length).toBeGreaterThan(0)
  })
})

describe('chat log', () => {
  async function log(banned: string[] = []) {
    const { identity } = await generateIdentity()
    const shown: string[] = []
    const chat = new ChatLog({ identity, isBanned: (id) => banned.includes(id), onChat: (m) => shown.push(m.text) })
    return { identity, chat, shown }
  }

  it('keeps the newest CHAT_KEEP by time, refusing duplicates and messages older than all kept', async () => {
    const { chat, shown } = await log()
    const { identity: author } = await generateIdentity()
    const t0 = Date.now()
    const envs = await Promise.all(Array.from({ length: CHAT_KEEP }, (_, i) => chatEnv(author, `m${i}`, t0 - CHAT_KEEP + i)))
    // A snapshot's history isn't rate limited.
    for (const env of envs.reverse()) expect(await chat.receive(env, true)).toBe(author.id)
    expect(chat.messages.map((m) => m.text)).toEqual(Array.from({ length: CHAT_KEEP }, (_, i) => `m${i}`))
    expect(await chat.receive(envs[0], true)).toBeNull()
    expect(await chat.receive(await chatEnv(author, 'ancient', t0 - 1e6), true)).toBeNull()
    expect(await chat.receive(await chatEnv(author, 'new', t0), true)).toBe(author.id)
    expect(chat.messages.at(-1)!.text).toBe('new')
    expect(chat.messages[0].text).toBe('m1')
    expect(chat.envelopes()).toHaveLength(CHAT_KEEP)
    expect(shown).toHaveLength(CHAT_KEEP + 1)
  })

  it('refuses banned authors and envelopes signed by someone other than the named sender', async () => {
    const { identity: bad } = await generateIdentity()
    const { identity: other } = await generateIdentity()
    const { chat } = await log([bad.id])
    expect(await chat.receive(await chatEnv(bad, 'hi'))).toBeNull()
    const forged = await seal(other, { type: 'chat', id: 'x', from: bad.id, name: 'x', text: 'hi', at: Date.now() })
    expect(await chat.receive(forged)).toBeNull()
    expect(chat.messages).toEqual([])
  })

  it("rate limits this peer's own messages and trims them", async () => {
    const { chat } = await log()
    expect(chat.send('   ', 'me')).toBeNull()
    for (let i = 0; i < 5; i++) expect(chat.send(` a${i} `, 'me')).not.toBeNull()
    expect(chat.send('a5', 'me')).toBeNull()
    await advance(10)
    expect(chat.messages.map((m) => m.text)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4'])
  })
})
