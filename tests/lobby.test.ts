import { describe, expect, it } from 'vitest'
import { hostIdentity, hostKeyFromCode, lobbyKeys, newHostSeed, openSignal, sealSignal, signOffer, verifyOffer } from '../src/net/lobby'

describe('lobby', () => {
  it('generates 128-bit url-safe host seeds', () => {
    const seed = newHostSeed()
    expect(seed).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newHostSeed()).not.toBe(seed)
  })

  it('derives a stable join code that pins the host key, without revealing the seed', async () => {
    const a = await hostIdentity('seed-a')
    expect(a.joinCode).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    expect(a.joinCode).not.toContain('seed-a')
    expect((await hostIdentity('seed-a')).joinCode).toBe(a.joinCode)
    expect((await hostIdentity('seed-b')).joinCode).not.toBe(a.joinCode)
    expect(await hostKeyFromCode(a.joinCode)).not.toBeNull()
    expect(await hostKeyFromCode('no-pinned-key')).toBeNull()
    expect(await hostKeyFromCode('secret.too-short')).toBeNull()
  })

  it('only accepts offers signed by the pinned host', async () => {
    const host = await hostIdentity('seed-a')
    const impostor = await hostIdentity('seed-b')
    const hostKey = (await hostKeyFromCode(host.joinCode))!
    const body = { peerId: 'h'.repeat(20), sdp: 'v=0' }
    const signed = await signOffer(host.signingKey, 'offer-1', body)
    expect(await verifyOffer(hostKey, 'offer-1', signed)).toBe(true)
    expect(await verifyOffer(hostKey, 'offer-2', signed)).toBe(false)
    expect(await verifyOffer(hostKey, 'offer-1', { ...signed, sdp: 'v=1' })).toBe(false)
    expect(await verifyOffer(hostKey, 'offer-1', { ...signed, peerId: 'x'.repeat(20) })).toBe(false)
    expect(await verifyOffer(hostKey, 'offer-1', body)).toBe(false)
    expect(await verifyOffer(hostKey, 'offer-1', await signOffer(impostor.signingKey, 'offer-1', body))).toBe(false)
  })

  it('carries the offer signature through sealing', async () => {
    const host = await hostIdentity('seed-a')
    const keys = await lobbyKeys(host.joinCode)
    const signed = await signOffer(host.signingKey, 'offer-1', { peerId: 'h'.repeat(20), sdp: 'v=0' })
    const opened = (await openSignal(keys, 'offer', 'offer-1', await sealSignal(keys, 'offer', 'offer-1', signed)))!
    expect(await verifyOffer((await hostKeyFromCode(host.joinCode))!, 'offer-1', opened)).toBe(true)
  })

  it('derives a stable 20-byte info hash that differs per code', async () => {
    const a = await lobbyKeys('code-a')
    expect(a.infoHash).toHaveLength(20)
    expect((await lobbyKeys('code-a')).infoHash).toBe(a.infoHash)
    expect((await lobbyKeys('code-b')).infoHash).not.toBe(a.infoHash)
  })

  it('round-trips a sealed signal', async () => {
    const keys = await lobbyKeys('code-a')
    const body = { peerId: 'p'.repeat(20), sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' }
    const sealed = await sealSignal(keys, 'offer', 'offer-1', body)
    expect(sealed).not.toContain('fingerprint')
    expect(await openSignal(keys, 'offer', 'offer-1', sealed)).toEqual(body)
  })

  it('rejects signals sealed with another code, for another offer, direction, or tampered', async () => {
    const keys = await lobbyKeys('code-a')
    const body = { peerId: 'p'.repeat(20), sdp: 'v=0' }
    const sealed = await sealSignal(keys, 'answer', 'offer-1', body)
    expect(await openSignal(await lobbyKeys('code-b'), 'answer', 'offer-1', sealed)).toBeNull()
    expect(await openSignal(keys, 'answer', 'offer-2', sealed)).toBeNull()
    expect(await openSignal(keys, 'offer', 'offer-1', sealed)).toBeNull()
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1)
    expect(await openSignal(keys, 'answer', 'offer-1', flipped)).toBeNull()
    expect(await openSignal(keys, 'answer', 'offer-1', 'v=0 plain sdp')).toBeNull()
  })
})
