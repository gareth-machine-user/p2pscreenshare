import { describe, expect, it } from 'vitest'
import { fromBase64Url, hostIdentity, hostKeyFromCode, lobbyKeys, newHostSeed, openJson, sealJson, toBase64Url } from '../src/net/lobby'
import { fromBase64, toBase64 } from '../src/util/base64'

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

  it('round-trips bytes through base64 and base64url', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    for (const n of [0, 1, 2, 3, 256]) {
      const bytes = all.subarray(0, n)
      expect(fromBase64(toBase64(bytes))).toEqual(bytes)
      const url = toBase64Url(bytes)
      expect(url).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(fromBase64Url(url)).toEqual(bytes)
    }
  })

  it('derives a stable 20-byte info hash that differs per code', async () => {
    const a = await lobbyKeys('code-a')
    expect(a.infoHash).toHaveLength(20)
    expect((await lobbyKeys('code-a')).infoHash).toBe(a.infoHash)
    expect((await lobbyKeys('code-b')).infoHash).not.toBe(a.infoHash)
  })

  it('round-trips a sealed value', async () => {
    const keys = await lobbyKeys('code-a')
    const body = { peerId: 'p'.repeat(20), sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' }
    const sealed = await sealJson(keys, 'offer', 'offer-1', body)
    expect(sealed).not.toContain('fingerprint')
    expect(await openJson(keys, 'offer', 'offer-1', sealed)).toEqual(body)
  })

  it('rejects signals sealed with another code, for another offer, direction, or tampered', async () => {
    const keys = await lobbyKeys('code-a')
    const body = { peerId: 'p'.repeat(20), sdp: 'v=0' }
    const sealed = await sealJson(keys, 'answer', 'offer-1', body)
    expect(await openJson(await lobbyKeys('code-b'), 'answer', 'offer-1', sealed)).toBeNull()
    expect(await openJson(keys, 'answer', 'offer-2', sealed)).toBeNull()
    expect(await openJson(keys, 'offer', 'offer-1', sealed)).toBeNull()
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1)
    expect(await openJson(keys, 'answer', 'offer-1', flipped)).toBeNull()
    expect(await openJson(keys, 'answer', 'offer-1', 'v=0 plain sdp')).toBeNull()
  })
})
