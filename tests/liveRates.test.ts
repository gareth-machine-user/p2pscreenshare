import { describe, expect, it } from 'vitest'
import type { LinkRow } from '../src/session/peerSession'
import { fmtMbps, livePeers, peerLive, sumKbps, uploadBadge } from '../src/ui/liveRates'
import { rateReason, rateText, type RateStatus } from '../src/ui/rateText'

const row = (lane: number, o: Partial<LinkRow> = {}): LinkRow => ({
  lane,
  sendKbps: null,
  recvKbps: null,
  mediaKbps: null,
  deliveredKbps: null,
  capKbps: null,
  bound: false,
  backlogged: false,
  rttMs: null,
  baselineMs: null,
  fresh: true,
  queueMs: null,
  drops: null,
  stalled: false,
  relayed: false,
  cwnd: null,
  ...o,
})

describe('live rates', () => {
  it('formats in Mbps, keeping small rates visible', () => {
    expect(fmtMbps(2345)).toBe('2.3 Mbps')
    expect(fmtMbps(12_000)).toBe('12.0 Mbps')
    expect(fmtMbps(60)).toBe('0.06 Mbps')
    expect(fmtMbps(0)).toBe('0.0 Mbps')
    expect(fmtMbps(null)).toBe('—')
    expect(fmtMbps(NaN)).toBe('—')
  })

  it('sums what is known', () => {
    expect(sumKbps([100, null, 50])).toBe(150)
    expect(sumKbps([null, undefined])).toBeNull()
    expect(sumKbps([])).toBeNull()
  })

  it("a peer's live figures add up its connections; RTT from the mesh link", () => {
    const p = peerLive([
      row(1, { sendKbps: 1200, recvKbps: 30, rttMs: 9, baselineMs: 4 }),
      row(0, { sendKbps: 800, recvKbps: 20, rttMs: 12, baselineMs: 5 }),
    ])
    expect(p).toMatchObject({ sendKbps: 2000, recvKbps: 50, rttMs: 12, baselineMs: 5 })
    expect(p.breakdown.split('\n')).toEqual(['lane 1: ↑ 1.2 Mbps ↓ 30 kbps, RTT 9 ms', 'mesh link: ↑ 800 kbps ↓ 20 kbps, RTT 12 ms'])
    // No RTT on the mesh link yet: a lane's.
    expect(peerLive([row(0), row(1, { rttMs: 7, baselineMs: 6 })]).rttMs).toBe(7)
    expect(peerLive([])).toMatchObject({ sendKbps: null, recvKbps: null, rttMs: null })
  })

  it('every member in join order: estimates for all, live rates for direct links, totals for you', () => {
    const rows = livePeers({
      selfId: 'me',
      members: [
        { id: 'far', name: '', joinedAt: 30, capacityKbps: 5000 },
        { id: 'me', name: 'Me', joinedAt: 10, capacityKbps: 20_000 },
        { id: 'near', name: 'Near', joinedAt: 20, capacityKbps: null },
      ],
      linksFor: (id) => (id === 'near' ? [row(0, { sendKbps: 1500, recvKbps: 40, rttMs: 12, baselineMs: 8 })] : []),
      totals: { sendKbps: 1600, recvKbps: 900 },
    })
    expect(rows.map((r) => r.id)).toEqual(['me', 'near', 'far'])
    expect(rows[0]).toMatchObject({ self: true, sendKbps: 1600, recvKbps: 900, estKbps: 20_000, direct: false })
    expect(rows[1]).toMatchObject({ name: 'Near', direct: true, sendKbps: 1500, recvKbps: 40, rttMs: 12, baselineMs: 8, estKbps: null })
    // No link: only the estimate (and a name from the id when it has none).
    expect(rows[2]).toMatchObject({ name: 'far', direct: false, sendKbps: null, recvKbps: null, estKbps: 5000 })
  })

  it("the presenter's upload badge warns while the bitrate is held below the chosen quality", () => {
    expect(uploadBadge({ sendKbps: 2100, capacityKbps: null, rate: null })).toEqual({
      text: 'Uploading 2.1 Mbps',
      warn: false,
      title: 'Live upload (all connections, last 2 s).',
    })
    const held = uploadBadge({ sendKbps: 900, capacityKbps: 1200, rate: 'Bitrate 0.8 Mbps of 2.5 Mbps: limited by your upload: ~1.2 Mbps.' })
    expect(held.warn).toBe(true)
    expect(held.title).toContain('Your upload carries about 1.2 Mbps.')
    expect(held.title).toContain('limited by your upload')
    // This computer can't keep up: said so, and not blamed on the network.
    const local = uploadBadge({ sendKbps: 900, capacityKbps: null, rate: null, local: { stallMs: 800, encoderDroppedFps: 6 } })
    expect(local.warn).toBe(true)
    expect(local.title).toContain("Your computer can't keep up (the encoder is dropping 6 frames/s, the page stalled for 0.8 s)")
  })

  it("a peer's capacity adds up its connections; stalled ones are marked", () => {
    const p = peerLive([row(0, { capKbps: 9000, bound: true }), row(1, { capKbps: 6000, stalled: true })])
    expect(p).toMatchObject({ capKbps: 15_000, bound: true, stalled: true })
    expect(p.breakdown).toContain('lane 1: ↑ — ↓ —, RTT —, stalled')
    expect(peerLive([row(0)])).toMatchObject({ capKbps: null, bound: false, stalled: false })
  })
})

describe('bitrate reason', () => {
  const st = (o: Partial<RateStatus> = {}): RateStatus => ({
    currentKbps: 16_000,
    chosenKbps: 16_000,
    limit: 'chosen',
    targetKbps: 16_000,
    uplinkKbps: 40_000,
    medianPeerKbps: null,
    feasibleKbps: null,
    stalledLanes: 0,
    ...o,
  })

  it('says what sets the bitrate, in plain words', () => {
    expect(rateReason(st())).toBe('at chosen quality')
    expect(rateText(st())).toBeNull()
    expect(rateReason(st({ limit: 'uplink', uplinkKbps: 8000, currentKbps: 5500 }))).toBe('limited by your upload: ~8.0 Mbps')
    expect(rateReason(st({ limit: 'viewers', medianPeerKbps: 3000, currentKbps: 2000 }))).toBe("limited by viewers' connections: median ~3.0 Mbps")
    expect(rateReason(st({ limit: 'audience', currentKbps: 6000 }))).toBe('limited by audience relay capacity')
    expect(rateReason(st({ currentKbps: 12_000 }))).toBe('rising back to the chosen quality')
    expect(rateText(st({ limit: 'uplink', uplinkKbps: 8000, currentKbps: 5500 }))).toMatch(/^Bitrate 5\.5 Mbps of 16 Mbps: limited by your upload: ~8\.0 Mbps\./)
  })
})
