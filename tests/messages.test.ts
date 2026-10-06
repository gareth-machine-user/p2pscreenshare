import { describe, expect, it } from 'vitest'
import {
  isPublisherMsg,
  isSubscriberMsg,
  isTopologyReport,
  parsePeerMsg,
  PEER_MSG_TYPES,
  PUBLISHER_MSG_TYPES,
  SUBSCRIBER_MSG_TYPES,
  type PeerMsg,
  type SubscriberStats,
  type TopologyReport,
} from '../src/proto/messages'

const stats: SubscriberStats = {
  capKbps: null,
  capacityKbps: 4000,
  uplinkKbps: 1200,
  uplinkDropRate: 0,
  stripes: [
    { parent: 'a', lastRecvAgoMs: 12, rttMs: 30, lateMs: 5 },
    { parent: null, lastRecvAgoMs: null, rttMs: null, lateMs: 0 },
  ],
  children: 1,
  latencyMs: null,
  bufferMs: 120,
  fps: 30,
  decodedFrames: 100,
  droppedFrames: 0,
  waitingForKeyframe: false,
  loss: { incomingFps: 30, incomplete: 0, late: 0, undecodable: 0, skipped: 0, notRendered: 0 },
  uplinkRates: { kbps: 1200, drops: [0, 0, 0], stalls: 0, queueMs: 3 },
}

const valid: PeerMsg[] = [
  { t: 'subscribe', ch: 1 },
  { t: 'unsubscribe', ch: 1 },
  { t: 'stripe-ok', ch: 1, stripe: 0, parent: 'p' },
  { t: 'reattach', ch: 1, stripe: 2, linkOpen: true },
  { t: 'need-key', ch: 1 },
  { t: 'stats', ch: 1, stats },
  { t: 'stats', ch: 1, stats: { ...stats, loss: undefined, uplinkRates: undefined } },
  { t: 'topo-req', ch: 1, on: false },
  { t: 'set-parent', ch: 1, stripe: 0, parent: null },
  { t: 'set-parent', ch: 1, stripe: 0, parent: 'p' },
  { t: 'add-child', ch: 1, stripe: 1, child: 'c' },
  { t: 'remove-child', ch: 1, stripe: 1, child: 'c' },
  { t: 'position', ch: 1, home: null, depth: [] },
  { t: 'position', ch: 1, home: 2, depth: [1, 2, 3] },
  { t: 'topo', ch: 1, z: 'abc' },
  { t: 'reprobe', ch: 1 },
  { t: 'publish-req' },
  { t: 'publish-deny' },
  { t: 'probe-end', id: 7 },
  { t: 'probe-result', bytes: 1000, ms: 50 },
]

const roundTrip = (v: unknown): unknown => JSON.parse(JSON.stringify(v))

describe('peer message validation', () => {
  it('lists every type once', () => {
    expect(new Set(PEER_MSG_TYPES).size).toBe(PEER_MSG_TYPES.length)
    expect(new Set(valid.map((m) => m.t))).toEqual(new Set(PEER_MSG_TYPES))
  })

  it('accepts well-formed messages (after a JSON round trip)', () => {
    for (const m of valid) expect(parsePeerMsg(roundTrip(m)), m.t).toEqual(roundTrip(m))
  })

  it('ignores extra fields', () => {
    expect(parsePeerMsg({ t: 'subscribe', ch: 1, extra: 'x' })).not.toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', 'subscribe'],
    ['an array', [{ t: 'subscribe', ch: 1 }]],
    ['no type', { ch: 1 }],
    ['a non-string type', { t: 1, ch: 1 }],
    ['an unknown type', { t: 'explode', ch: 1 }],
    ['an inherited key as type', { t: 'toString' }],
    ['a missing channel', { t: 'subscribe' }],
    ['a string channel', { t: 'subscribe', ch: '1' }],
    ['a NaN channel', { t: 'need-key', ch: NaN }],
    ['an infinite channel', { t: 'need-key', ch: Infinity }],
    ['a negative stripe', { t: 'set-parent', ch: 1, stripe: -1, parent: null }],
    ['a fractional stripe', { t: 'add-child', ch: 1, stripe: 0.5, child: 'c' }],
    ['a missing parent', { t: 'set-parent', ch: 1, stripe: 0 }],
    ['a null stripe-ok parent', { t: 'stripe-ok', ch: 1, stripe: 0, parent: null }],
    ['a numeric child', { t: 'remove-child', ch: 1, stripe: 0, child: 3 }],
    ['a non-boolean linkOpen', { t: 'reattach', ch: 1, stripe: 0, linkOpen: 'yes' }],
    ['a non-boolean on', { t: 'topo-req', ch: 1, on: 1 }],
    ['a depth that is not numbers', { t: 'position', ch: 1, home: null, depth: ['1'] }],
    ['a missing depth', { t: 'position', ch: 1, home: 0 }],
    ['a negative home', { t: 'position', ch: 1, home: -1, depth: [] }],
    ['a non-string topo payload', { t: 'topo', ch: 1, z: {} }],
    ['a missing probe id', { t: 'probe-end' }],
    ['a string probe result', { t: 'probe-result', bytes: '1', ms: 2 }],
    ['missing stats', { t: 'stats', ch: 1 }],
    ['stats without stripes', { t: 'stats', ch: 1, stats: { ...stats, stripes: undefined } }],
    ['stats with a bad stripe', { t: 'stats', ch: 1, stats: { ...stats, stripes: [{ parent: 3, lateMs: 0, lastRecvAgoMs: null, rttMs: null }] } }],
  ])('rejects %s', (_, v) => {
    expect(parsePeerMsg(v)).toBeNull()
  })

  it('repairs bad telemetry in stats instead of dropping the report', () => {
    // NaN and Infinity become null in JSON; the stripe data must still reach the publisher.
    const sent = JSON.parse(JSON.stringify({ t: 'stats', ch: 1, stats: { ...stats, uplinkKbps: NaN, fps: Infinity, uplinkDropRate: '0.5', loss: { incomingFps: 1 }, stripes: [{ parent: 'p', lastRecvAgoMs: null, rttMs: null }] } }))
    const m = parsePeerMsg(sent)
    expect(m?.t).toBe('stats')
    const s = (m as Extract<PeerMsg, { t: 'stats' }>).stats
    expect(s.uplinkKbps).toBe(0)
    expect(s.fps).toBe(0)
    expect(s.uplinkDropRate).toBe(0)
    expect(s.loss).toBeUndefined()
    expect(s.stripes).toEqual([{ parent: 'p', lastRecvAgoMs: null, rttMs: null, lateMs: 0 }])
  })

  it('classifies subscriber and publisher messages', () => {
    for (const m of valid) {
      expect(isSubscriberMsg(m)).toBe((SUBSCRIBER_MSG_TYPES as readonly string[]).includes(m.t))
      expect(isPublisherMsg(m)).toBe((PUBLISHER_MSG_TYPES as readonly string[]).includes(m.t))
    }
    expect(isSubscriberMsg({ t: 'publish-req' })).toBe(false)
    expect(isPublisherMsg({ t: 'publish-req' })).toBe(false)
  })
})

describe('topology report validation', () => {
  const report: TopologyReport = {
    channel: 1,
    publisher: 'pub',
    k: 2,
    m: 1,
    topology: { parents: { a: ['pub', null, 'pub'] }, home: { a: 0 } },
    depth: { a: [1, 0, 1] },
    slots: { a: 2 },
    rootSlots: 3,
    overcommitted: 0,
    changes: 4,
    peers: [
      { id: 'a', failures: 0, avoid: [], stats },
      { id: 'b', failures: 1, avoid: ['a'], stats: null },
    ],
  }

  it('accepts a well-formed report', () => {
    expect(isTopologyReport(roundTrip(report))).toBe(true)
  })

  it('rejects malformed reports', () => {
    expect(isTopologyReport(null)).toBe(false)
    expect(isTopologyReport({ ...report, peers: {} })).toBe(false)
    expect(isTopologyReport({ ...report, depth: { a: 'deep' } })).toBe(false)
    expect(isTopologyReport({ ...report, topology: { parents: {} } })).toBe(false)
    expect(isTopologyReport({ ...report, peers: [{ id: 'a', avoid: [], stats: { fps: 1 } }] })).toBe(false)
  })
})
