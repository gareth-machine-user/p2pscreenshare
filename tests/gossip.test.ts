import { describe, expect, it } from 'vitest'
import { gunzip, gzip, MAX_INFLATED_BYTES, open, seal, type Envelope } from '../src/mesh/envelope'
import { generateIdentity, ownerIdFromCode, ownerIdentity } from '../src/mesh/identity'
import { doorPeers, FailureDetector, isMemberRecord, linkSuspected, RecordStore, retryDelayMs, type MemberRecord } from '../src/mesh/records'
import { hostIdentity } from '../src/net/lobby'

function rec(id: string, version: number, over: Partial<MemberRecord> = {}): MemberRecord {
  return {
    type: 'rec',
    id,
    name: id,
    joinedAt: 0,
    version,
    heartbeat: version,
    capacityKbps: null,
    offers: {},
    subs: [],
    unreachable: [],
    rtt: {},
    channels: [],
    ...over,
  }
}

const env = (r: MemberRecord): Envelope => ({ k: 'k', b: JSON.stringify(r), s: `sig-${r.id}-${r.version}` })

describe('record store', () => {
  it('keeps the newest version of each record', () => {
    const s = new RecordStore()
    expect(s.accept(rec('a', 2), env(rec('a', 2)), 0)).toBe(true)
    expect(s.accept(rec('a', 1), env(rec('a', 1)), 1)).toBe(false)
    expect(s.accept(rec('a', 2), env(rec('a', 2)), 1)).toBe(false)
    expect(s.accept(rec('a', 3, { name: 'new' }), env(rec('a', 3)), 2)).toBe(true)
    expect(s.get('a')!.rec.name).toBe('new')
    expect(s.get('a')!.at).toBe(2)
  })

  it('does not resurrect a departed peer from an older copy', () => {
    const s = new RecordStore()
    s.accept(rec('a', 5), env(rec('a', 5)), 0)
    s.remove('a')
    expect(s.accept(rec('a', 5), env(rec('a', 5)), 1)).toBe(false)
    expect(s.has('a')).toBe(false)
    // A newer record (the peer came back) is accepted.
    expect(s.accept(rec('a', 6), env(rec('a', 6)), 2)).toBe(true)
  })

  it('a graceful leave removes the record', () => {
    const s = new RecordStore()
    s.accept(rec('a', 5), env(rec('a', 5)), 0)
    expect(s.accept(rec('a', 6, { left: true }), env(rec('a', 6)), 1)).toBe(true)
    expect(s.has('a')).toBe(false)
    expect(s.accept(rec('a', 5), env(rec('a', 5)), 2)).toBe(false)
  })

  it('digest anti-entropy converges two stores', () => {
    const x = new RecordStore()
    const y = new RecordStore()
    for (const r of [rec('a', 3), rec('b', 1), rec('c', 7)]) x.accept(r, env(r), 0)
    for (const r of [rec('a', 1), rec('b', 4), rec('d', 2)]) y.accept(r, env(r), 0)

    const fromX = x.compare(y.digest())
    expect(fromX.pull.sort()).toEqual(['b', 'd'])
    expect(fromX.push.map((e) => JSON.parse(e.b).id).sort()).toEqual(['a', 'c'])

    // Exchange: x pushes what y lacks, y answers x's pulls.
    for (const e of fromX.push) {
      const r = JSON.parse(e.b) as MemberRecord
      y.accept(r, e, 1)
    }
    for (const id of fromX.pull) {
      const s = y.get(id)!
      x.accept(s.rec, s.env, 1)
    }
    expect(x.digest()).toEqual(y.digest())
    expect(x.compare(y.digest())).toEqual({ pull: [], push: [] })
  })

  it('does not pull versions it has already buried', () => {
    const s = new RecordStore()
    s.accept(rec('a', 5), env(rec('a', 5)), 0)
    s.remove('a')
    expect(s.compare({ a: 5 }).pull).toEqual([])
    expect(s.compare({ a: 6 }).pull).toEqual(['a'])
  })
})

describe('failure detection', () => {
  it('declares a peer gone only after the window passes with nothing heard', () => {
    const d = new FailureDetector(6000)
    d.heard('a', 0)
    d.heard('b', 0)
    d.heard('a', 5000) // a fresher record (or pong) arrived
    expect(d.gone(6001)).toEqual(['b'])
    expect(d.gone(11_001)).toEqual(['a', 'b'])
    d.forget('b')
    expect(d.gone(11_001)).toEqual(['a'])
  })

  it('never moves the last-heard time backwards', () => {
    const d = new FailureDetector(6000)
    d.heard('a', 5000)
    d.heard('a', 1000)
    expect(d.lastHeardAt('a')).toBe(5000)
  })

  it('suspects a link that is closed or whose ping is overdue', () => {
    expect(linkSuspected({ open: false, pingSentAt: null, lastPongAt: 0 }, 0)).toBe(true)
    expect(linkSuspected({ open: true, pingSentAt: null, lastPongAt: 0 }, 10_000)).toBe(false)
    expect(linkSuspected({ open: true, pingSentAt: 1000, lastPongAt: 0 }, 2400)).toBe(false)
    expect(linkSuspected({ open: true, pingSentAt: 1000, lastPongAt: 0 }, 2600)).toBe(true)
    expect(linkSuspected({ open: true, pingSentAt: 1000, lastPongAt: 1100 }, 9000)).toBe(false)
  })
})

describe('door duty and retries', () => {
  it('owner plus the two oldest other members', () => {
    const members = [
      { id: 'o', joinedAt: 50 },
      { id: 'x', joinedAt: 30 },
      { id: 'y', joinedAt: 10 },
      { id: 'z', joinedAt: 20 },
    ]
    expect([...doorPeers(members, 'o')].sort()).toEqual(['o', 'y', 'z'])
    // Owner away: just the two oldest.
    expect([...doorPeers(members.filter((m) => m.id !== 'o'), 'o')].sort()).toEqual(['y', 'z'])
  })

  it('backs off from 60 s to 10 min', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  })
})

describe('member record validation', () => {
  const channel = { id: 7, kind: 'full', k: 4, m: 2, kbps: 2000, stripeKbps: 600, stream: null, deficit: 0, startedAt: 1 }
  const stream = { epoch: 1, codec: 'avc1.42e01f', codedWidth: 1920, codedHeight: 1080, audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 } }

  it('accepts well-formed records', () => {
    expect(isMemberRecord(rec('a', 1))).toBe(true)
    const full = rec('a', 1, {
      capacityKbps: 5000,
      offers: { '7': 3 },
      subs: [7],
      unreachable: ['b'],
      links: ['c'],
      rtt: { c: 20 },
      channels: [{ ...channel, stream } as MemberRecord['channels'][number]],
      left: false,
    })
    expect(isMemberRecord(full)).toBe(true)
    expect(isMemberRecord(JSON.parse(JSON.stringify(full)))).toBe(true)
  })

  it('rejects records consumers would crash on', () => {
    const bad: Record<string, unknown>[] = [
      { unreachable: null },
      { unreachable: [1] },
      { offers: null },
      { offers: [] },
      { offers: { '7': 'x' } },
      { rtt: null },
      { rtt: { b: null } },
      { channels: null },
      { channels: [null] },
      { channels: [{ ...channel, k: 0 }] },
      { channels: [{ ...channel, m: -1 }] },
      { channels: [{ ...channel, k: 200, m: 100 }] },
      { channels: [{ ...channel, kind: 'other' }] },
      { channels: [{ ...channel, stripeKbps: 0 }] },
      { channels: [{ ...channel, stream: { ...stream, codec: 5 } }] },
      { channels: [{ ...channel, stream: { ...stream, audio: null } }] },
      { links: 'x' },
      { subs: null },
      { name: null },
      { version: '9' },
      { joinedAt: null },
      { capacityKbps: 'fast' },
      { left: 1 },
    ]
    for (const over of bad) expect(isMemberRecord({ ...rec('a', 1), ...over }), JSON.stringify(over)).toBe(false)
    expect(isMemberRecord(null)).toBe(false)
    expect(isMemberRecord({ ...rec('a', 1), type: 'chat' })).toBe(false)
  })
})

describe('gzip limits', () => {
  it('inflates bodies within the limit', async () => {
    const text = 'x'.repeat(100_000)
    expect(await gunzip(await gzip(text))).toBe(text)
  })

  it('rejects bodies that inflate past the limit', async () => {
    const bomb = await gzip('0'.repeat(MAX_INFLATED_BYTES + 1))
    expect(bomb.length).toBeLessThan(MAX_INFLATED_BYTES / 100)
    await expect(gunzip(bomb)).rejects.toThrow()
    await expect(gunzip(await gzip('y'.repeat(2000)), 1000)).rejects.toThrow()
  })

  it('open() refuses a signed gzip bomb', async () => {
    const { identity } = await generateIdentity()
    const e = await seal(identity, rec(identity.id, 1, { name: 'n'.repeat(MAX_INFLATED_BYTES) }))
    expect(e.z).toBe(1)
    expect(await open<MemberRecord>(e, 'rec')).toBeNull()
  })
})

describe('signed envelopes', () => {
  it('round-trips and binds the author id to the key', async () => {
    const { identity } = await generateIdentity()
    const e = await seal(identity, rec(identity.id, 1))
    const opened = await open<MemberRecord>(e, 'rec')
    expect(opened?.author).toBe(identity.id)
    expect(opened?.body.version).toBe(1)
  })

  it('compresses large bodies', async () => {
    const { identity } = await generateIdentity()
    const rtt = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`peer-${String(i).padStart(15, '0')}`, 40 + i]))
    const big = rec(identity.id, 1, { rtt })
    const e = await seal(identity, big)
    expect(e.z).toBe(1)
    expect(e.b.length).toBeLessThan(JSON.stringify(big).length)
    expect((await open<MemberRecord>(e, 'rec'))?.body.rtt).toEqual(rtt)
  })

  it('rejects tampering, a swapped key, and the wrong type', async () => {
    const a = (await generateIdentity()).identity
    const b = (await generateIdentity()).identity
    const e = await seal(a, rec(a.id, 1))
    expect(await open(e, 'chat')).toBeNull()
    expect(await open({ ...e, b: e.b.replace('"version":1', '"version":2') }, 'rec')).toBeNull()
    expect(await open({ ...e, k: b.pubKey }, 'rec')).toBeNull()
    expect(await open({ k: 1 }, 'rec')).toBeNull()
  })

  it("the owner's identity matches the key pinned in the join code", async () => {
    const { joinCode } = await hostIdentity('seed-a')
    expect((await ownerIdentity('seed-a')).id).toBe(await ownerIdFromCode(joinCode))
    expect(await ownerIdFromCode('no-key')).toBeNull()
  })
})
