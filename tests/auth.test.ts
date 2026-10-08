import { describe, expect, it } from 'vitest'
import { ban, emptyAuth, grant, isBanned, mayPublish, revoke, setPolicy, type AuthDoc } from '../src/mesh/auth'
import { AuthState } from '../src/mesh/authState'
import { open, seal } from '../src/mesh/envelope'
import { generateIdentity, ownerIdentity, ownerIdFromCode, type PeerIdentity } from '../src/mesh/identity'
import { hostIdentity } from '../src/net/lobby'

describe('publish rights', () => {
  it('the owner always may; others need a grant', () => {
    const doc = emptyAuth()
    expect(mayPublish(doc, 'owner-key', true)).toBe(true)
    expect(mayPublish(doc, 'a', false)).toBe(false)
    const g = grant(doc, 'a')
    expect(g.version).toBeGreaterThan(doc.version)
    expect(mayPublish(g, 'a', false)).toBe(true)
    expect(mayPublish(g, 'b', false)).toBe(false)
    expect(mayPublish(g, undefined, false)).toBe(false)
  })

  it('a grant is bound to a key', () => {
    const g = grant(emptyAuth(), 'key-a')
    // Someone else claiming the grant has a different key.
    expect(mayPublish(g, 'key-b', false)).toBe(false)
  })

  it('revocation wins over grants and the open policy, until re-granted', () => {
    let d = setPolicy(grant(emptyAuth(), 'a'), 'open')
    expect(mayPublish(d, 'b', false)).toBe(true)
    d = revoke(d, 'a')
    expect(mayPublish(d, 'a', false)).toBe(false)
    expect(mayPublish(d, 'b', false)).toBe(true)
    d = grant(d, 'a')
    expect(mayPublish(d, 'a', false)).toBe(true)
    expect(d.revoked).not.toContain('a')
  })

  it('closed refuses everyone but the owner and existing grants', () => {
    const d = setPolicy(grant(emptyAuth(), 'a'), 'closed')
    expect(mayPublish(d, 'a', false)).toBe(true)
    expect(mayPublish(d, 'b', false)).toBe(false)
  })

  it('a banned key can do nothing', () => {
    const d = ban(setPolicy(grant(emptyAuth(), 'a'), 'open'), 'a')
    expect(isBanned(d, 'a')).toBe(true)
    expect(mayPublish(d, 'a', false)).toBe(false)
  })

  it('versions only go up', () => {
    let d: AuthDoc = emptyAuth()
    const seen: number[] = []
    for (const f of [(x: AuthDoc) => grant(x, 'a'), (x: AuthDoc) => revoke(x, 'a'), (x: AuthDoc) => setPolicy(x, 'open')]) {
      d = f(d)
      seen.push(d.version)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
    expect(new Set(seen).size).toBe(3)
  })

  it('only an envelope signed by the pinned owner key counts', async () => {
    const { joinCode } = await hostIdentity('seed-a')
    const ownerId = await ownerIdFromCode(joinCode)
    const owner = await ownerIdentity('seed-a')
    const impostor = (await generateIdentity()).identity
    const doc = grant(emptyAuth(), impostor.pubKey)
    const real = await open<AuthDoc>(await seal(owner, doc), 'auth')
    const fake = await open<AuthDoc>(await seal(impostor, doc), 'auth')
    expect(real?.author).toBe(ownerId)
    // A forged document verifies as the impostor's, which the mesh ignores.
    expect(fake?.author).not.toBe(ownerId)
  })
})

describe('auth state', () => {
  function memoryStore() {
    const m = new Map<string, string>()
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
  }

  function state(identity: PeerIdentity, ownerId: string, storage = memoryStore()) {
    const accepted: number[] = []
    const s = new AuthState({ identity, ownerId, joinCode: 'c', storage, onAccept: () => accepted.push(s.doc.version) })
    return { s, accepted, storage }
  }

  it('bans by peer id before the key is known, and only the owner decides', async () => {
    const { identity: owner } = await generateIdentity()
    const { identity: member } = await generateIdentity()
    const { identity: kicked } = await generateIdentity()
    const o = state(owner, owner.id)
    await o.s.update((d) => ban(d, kicked.pubKey))
    const m = state(member, owner.id)
    await expect(m.s.update((d) => d)).rejects.toThrow()
    // Not the owner's signature: ignored.
    await m.s.accept(await seal(member, ban(emptyAuth(), kicked.pubKey)))
    expect(m.s.isBanned(kicked.id, undefined)).toBe(false)
    await m.s.accept(o.s.env!)
    expect(m.s.isBanned(kicked.id, undefined)).toBe(true)
    expect(m.s.isBanned(member.id, member.pubKey)).toBe(false)
    // An older document doesn't undo a newer one.
    const older = await seal(owner, { ...emptyAuth(), version: 1 })
    await m.s.accept(older)
    expect(m.accepted).toHaveLength(1)
  })

  it("the owner's decisions survive a reload; a corrupt saved copy is ignored", async () => {
    const { identity: owner } = await generateIdentity()
    const first = state(owner, owner.id)
    await first.s.update((d) => setPolicy(d, 'open'))
    const again = state(owner, owner.id, first.storage)
    await again.s.restore()
    expect(again.s.doc.policy).toBe('open')
    first.storage.m.set('p2pss:auth:c', '{not json')
    const broken = state(owner, owner.id, first.storage)
    await broken.s.restore()
    expect(broken.s.doc).toEqual(emptyAuth())
  })
})
