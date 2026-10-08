import { describe, expect, it } from 'vitest'
import {
  isPublisherMsg,
  isSubscriberMsg,
  isTopologyReport,
  parsePeerMsg,
  PEER_MSG_TYPES,
  PUBLISHER_MSG_TYPES,
  SUBSCRIBER_MSG_TYPES,
  type EncoderRates,
  type PeerMsg,
  type SubscriberStats,
  type TopologyReport,
  type UplinkRates,
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
  { t: 'position', ch: 1, homes: [], depth: [] },
  { t: 'position', ch: 1, homes: [2, 0], depth: [1, 2, 3] },
  { t: 'topo', ch: 1, z: 'abc' },
  { t: 'publish-req' },
  { t: 'publish-deny' },
  { t: 'publish-cancel' },
  { t: 'need-gop', ch: 1, stripes: [0] },
  { t: 'need-gop', ch: 1, stripes: [0, 2, 3] },
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
    ['a depth that is not numbers', { t: 'position', ch: 1, homes: [], depth: ['1'] }],
    ['a missing depth', { t: 'position', ch: 1, homes: [0] }],
    ['a negative home', { t: 'position', ch: 1, homes: [-1], depth: [] }],
    ['homes that are not a list', { t: 'position', ch: 1, homes: 0, depth: [] }],
    ['a non-string topo payload', { t: 'topo', ch: 1, z: {} }],
    ['need-gop without stripes', { t: 'need-gop', ch: 1 }],
    ['need-gop with an empty stripe list', { t: 'need-gop', ch: 1, stripes: [] }],
    ['need-gop with a negative stripe', { t: 'need-gop', ch: 1, stripes: [0, -1] }],
    ['need-gop with a fractional stripe', { t: 'need-gop', ch: 1, stripes: [1.5] }],
    ['need-gop with a string stripe', { t: 'need-gop', ch: 1, stripes: ['0'] }],
    ['need-gop with stripes not a list', { t: 'need-gop', ch: 1, stripes: 0 }],
    ['need-gop with absurdly many stripes', { t: 'need-gop', ch: 1, stripes: Array.from({ length: 1000 }, (_, i) => i) }],
    ['need-gop without a channel', { t: 'need-gop', stripes: [0] }],
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
    topology: { parents: { a: ['pub', null, 'pub'] }, homes: { a: [0] } },
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

  it('carries the unattached count, optional for older publishers, dropped if malformed', () => {
    const withCount = roundTrip({ ...report, unattached: 2 }) as unknown as TopologyReport
    expect(isTopologyReport(withCount)).toBe(true)
    expect(withCount.unattached).toBe(2)
    const bad = roundTrip({ ...report, unattached: 'some' }) as unknown as TopologyReport
    expect(isTopologyReport(bad)).toBe(true)
    expect(bad.unattached).toBeUndefined()
  })

  it('rejects malformed reports', () => {
    expect(isTopologyReport(null)).toBe(false)
    expect(isTopologyReport({ ...report, peers: {} })).toBe(false)
    expect(isTopologyReport({ ...report, depth: { a: 'deep' } })).toBe(false)
    expect(isTopologyReport({ ...report, topology: { parents: {} } })).toBe(false)
    expect(isTopologyReport({ ...report, peers: [{ id: 'a', avoid: [], stats: { fps: 1 } }] })).toBe(false)
    expect(isTopologyReport({ ...report, changes: 'many' })).toBe(false)
    expect(isTopologyReport({ ...report, peers: [{ id: 'a', failures: '0', avoid: [], stats: null }] })).toBe(false)
    expect(isTopologyReport({ ...report, peers: [{ id: 'a', failures: 0, avoid: [7], stats: null }] })).toBe(false)
  })

  const encoder: EncoderRates = { codec: 'vp09', targetKbps: 5000, ceilingKbps: 5000, kbps: 4800, captureFps: 30, encodedFps: 30, droppedFps: 0, keyframes: 0.1, encodeMs: 4, maxFrameKB: 60 }
  const uplink: UplinkRates = { kbps: 9000, drops: [0, 0, 1], stalls: 0, queueMs: 3 }

  it("keeps the publisher's own stats and links when well formed", () => {
    const full = roundTrip({ ...report, publisherStats: { encoder, uplink }, peers: [{ ...report.peers[0], link: { drops: 1, queueMs: 2, backlogged: false, capKbps: null } }] }) as TopologyReport
    expect(isTopologyReport(full)).toBe(true)
    expect(full.publisherStats).toEqual({ encoder, uplink })
    expect(full.peers[0].link).toEqual({ drops: 1, queueMs: 2, backlogged: false, capKbps: null })
  })

  it('drops malformed display extras (the panel would crash on them) but keeps the report', () => {
    const bad = roundTrip({
      ...report,
      publisherStats: { encoder: { ...encoder, captureFps: 'x' }, uplink },
      peers: [{ ...report.peers[0], link: { drops: NaN, queueMs: 2, backlogged: false, capKbps: null } }],
    }) as unknown as TopologyReport
    expect(isTopologyReport(bad)).toBe(true)
    expect(bad.publisherStats).toBeUndefined()
    expect(bad.peers[0].link).toBeNull()
    const noDrops = roundTrip({ ...report, publisherStats: { encoder: null, uplink: { ...uplink, drops: undefined } } }) as unknown as TopologyReport
    expect(isTopologyReport(noDrops)).toBe(true)
    expect(noDrops.publisherStats).toBeUndefined()
  })
})
