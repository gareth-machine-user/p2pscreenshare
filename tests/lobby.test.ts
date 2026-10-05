import { describe, expect, it } from 'vitest'
import { lobbyKeys, newJoinCode, openSignal, sealSignal } from '../src/net/lobby'

describe('lobby', () => {
  it('generates 128-bit url-safe join codes', () => {
    const code = newJoinCode()
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newJoinCode()).not.toBe(code)
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
