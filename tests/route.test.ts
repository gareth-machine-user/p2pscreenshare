/// <reference types="vite/client" />
// (tsconfig.tools.json lacks the app type for import.meta.env used by src/ui/route.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fmtKbps, fmtMs, joinCodeFrom, lobbyUrl, numParam, parseRoute, sizeParam } from '../src/ui/route'

const CODE = 'abcDEF_-12.xyz-_789'

describe('parseRoute', () => {
  it('parses the home, lobby and legacy routes', () => {
    expect(parseRoute('')).toEqual({ page: 'home' })
    expect(parseRoute('#/')).toEqual({ page: 'home' })
    expect(parseRoute('#/lobby')).toEqual({ page: 'home' })
    expect(parseRoute('#/nope/x')).toEqual({ page: 'home' })
    const lobby = parseRoute(`#/lobby/${CODE}?tracker=ws://t`)
    expect(lobby).toMatchObject({ page: 'lobby', joinCode: CODE })
    expect(lobby.page === 'lobby' && lobby.params.get('tracker')).toBe('ws://t')
    expect(parseRoute(`#/watch/${CODE}`)).toMatchObject({ page: 'lobby', joinCode: CODE })
    const host = parseRoute('#/host?stream=seed')
    expect(host.page).toBe('host')
    expect(host.page === 'host' && host.params.get('stream')).toBe('seed')
  })

  it('decodes the join code and tolerates malformed percent-encoding', () => {
    expect(parseRoute('#/lobby/a%2Eb')).toMatchObject({ page: 'lobby', joinCode: 'a.b' })
    expect(() => parseRoute('#/lobby/abc%')).not.toThrow()
    expect(parseRoute('#/lobby/abc%')).toMatchObject({ page: 'lobby', joinCode: 'abc%' })
    expect(parseRoute('#/lobby/%E0%A4%A')).toMatchObject({ page: 'lobby', joinCode: '%E0%A4%A' })
  })
})

describe('joinCodeFrom', () => {
  it('accepts bare codes and pasted links', () => {
    expect(joinCodeFrom(CODE)).toBe(CODE)
    expect(joinCodeFrom(`  ${CODE}\n`)).toBe(CODE)
    expect(joinCodeFrom(`https://example.com/app/#/lobby/${CODE}?tracker=ws://t`)).toBe(CODE)
    expect(joinCodeFrom(`https://example.com/#/watch/${CODE}`)).toBe(CODE)
    expect(joinCodeFrom('https://example.com/#/lobby/a%2Eb')).toBe('a.b')
  })

  it('rejects bad codes without throwing', () => {
    expect(joinCodeFrom('')).toBeNull()
    expect(joinCodeFrom('no-dot')).toBeNull()
    expect(joinCodeFrom('a.b.c')).toBeNull()
    expect(joinCodeFrom('has space.x')).toBeNull()
    expect(joinCodeFrom('https://example.com/#/lobby/abc%')).toBeNull()
    expect(joinCodeFrom('https://example.com/#/home')).toBeNull()
  })
})

describe('lobbyUrl', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'https://example.com', pathname: '/app/', search: '' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries only tracker and ice overrides', () => {
    expect(lobbyUrl(CODE, new URLSearchParams())).toBe(`https://example.com/app/#/lobby/${CODE}`)
    const params = new URLSearchParams({ tracker: 'ws://t', ice: 'none', stream: 'secret' })
    expect(lobbyUrl(CODE, params)).toBe(`https://example.com/app/#/lobby/${CODE}?tracker=ws%3A%2F%2Ft&ice=none`)
  })
})

describe('numParam', () => {
  it('falls back on missing or non-numeric values', () => {
    const p = new URLSearchParams({ a: '42', b: 'x', d: '1.5', e: 'Infinity' })
    expect(numParam(p, 'a', 7)).toBe(42)
    expect(numParam(p, 'b', 7)).toBe(7)
    expect(numParam(p, 'missing', 7)).toBe(7)
    expect(numParam(p, 'd', 7)).toBe(1.5)
    expect(numParam(p, 'e', 7)).toBe(7)
  })
})

describe('sizeParam', () => {
  it('parses WxH and rejects malformed sizes', () => {
    const p = new URLSearchParams({ a: '1280x720', b: '1280', c: '0x720', d: '12.5x3', e: 'x', f: '-1x2', g: '640x360x2' })
    expect(sizeParam(p, 'a')).toEqual([1280, 720])
    expect(sizeParam(p, 'missing')).toBeUndefined()
    for (const key of ['b', 'c', 'd', 'e', 'f', 'g']) expect(sizeParam(p, key)).toBeUndefined()
  })
})

describe('formatting', () => {
  it('formats bitrates', () => {
    expect(fmtKbps(null)).toBe('—')
    expect(fmtKbps(undefined)).toBe('—')
    expect(fmtKbps(NaN)).toBe('—')
    expect(fmtKbps(999.6)).toBe('1000 kbps')
    expect(fmtKbps(250.4)).toBe('250 kbps')
    expect(fmtKbps(1000)).toBe('1.0 Mbps')
    expect(fmtKbps(4500)).toBe('4.5 Mbps')
  })

  it('formats durations', () => {
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(Infinity)).toBe('—')
    expect(fmtMs(12.4)).toBe('12 ms')
  })
})
