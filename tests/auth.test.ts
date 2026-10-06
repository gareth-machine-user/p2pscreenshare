import { describe, expect, it } from 'vitest'
import { ban, emptyAuth, grant, isBanned, mayPublish, revoke, setPolicy, type AuthDoc } from '../src/mesh/auth'
import { open, seal } from '../src/mesh/envelope'
import { generateIdentity, ownerIdentity, ownerIdFromCode } from '../src/mesh/identity'
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
