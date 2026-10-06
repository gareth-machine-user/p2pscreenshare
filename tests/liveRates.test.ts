import { describe, expect, it } from 'vitest'
import type { LinkRow } from '../src/session/peerSession'
import { fmtMbps, livePeers, peerLive, sumKbps, uploadBadge } from '../src/ui/liveRates'

const row = (lane: number, o: Partial<LinkRow> = {}): LinkRow => ({
  lane,
  sendKbps: null,
  recvKbps: null,
  mediaKbps: null,
  rttMs: null,
  baselineMs: null,
  fresh: true,
  queueMs: null,
  drops: null,
  congested: false,
  relayed: false,
  cwnd: null,
  availableKbps: null,
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

  it("the presenter's upload badge warns while the uplink holds the bitrate down", () => {
    expect(uploadBadge({ sendKbps: 2100, full: false, clamp: null, ccReason: 'raised: probing' })).toEqual({
      text: 'Uploading 2.1 Mbps',
      warn: false,
      title: 'Live upload (all connections, last 2 s)',
    })
    const full = uploadBadge({ sendKbps: 900, full: true, clamp: null, ccReason: 'lowered: your uplink is full' })
    expect(full.warn).toBe(true)
    expect(full.title).toContain('lowered: your uplink is full')
    const clamped = uploadBadge({ sendKbps: 900, full: false, clamp: 'Held at 1.0 Mbps: …', ccReason: null })
    expect(clamped).toMatchObject({ warn: true })
    expect(clamped.title).toContain('Held at 1.0 Mbps')
  })
})
