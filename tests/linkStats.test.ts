import { describe, expect, it } from 'vitest'
import { LinkStatsTracker, parseLinkStats, pathInflation, RTT_STALE_MS, rttInflationThreshold, type LinkStats, type StatsRecord } from '../src/net/linkStats'

/** A Chrome (150) report of a data-only connection, trimmed from a real dump (e2e/linkstats.spec.ts). */
function chrome(o: { rtt?: number; totalRtt?: number; responses?: number; bytesSent?: number; relay?: boolean; sctp?: boolean } = {}): StatsRecord[] {
  const out: StatsRecord[] = [
    { id: 'P', type: 'peer-connection', dataChannelsOpened: 3 },
    {
      id: 'T01',
      type: 'transport',
      bytesReceived: 47579,
      bytesSent: 1882145,
      dtlsState: 'connected',
      iceState: 'connected',
      selectedCandidatePairId: 'CPsel',
    },
    // A losing pair, also nominated-looking: must not be picked over the transport's choice.
    { id: 'CPother', type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.5, localCandidateId: 'Lb', remoteCandidateId: 'Rb' },
    {
      id: 'CPsel',
      type: 'candidate-pair',
      bytesDiscardedOnSend: 0,
      bytesReceived: 47579,
      bytesSent: o.bytesSent ?? 1882145,
      consentRequestsSent: 2,
      currentRoundTripTime: o.rtt ?? 0.001,
      localCandidateId: 'La',
      nominated: true,
      remoteCandidateId: 'Ra',
      requestsSent: 3,
      responsesReceived: o.responses ?? 3,
      state: 'succeeded',
      totalRoundTripTime: o.totalRtt ?? 0.002,
      transportId: 'T01',
      writable: true,
    },
    { id: 'La', type: 'local-candidate', candidateType: o.relay ? 'relay' : 'host' },
    { id: 'Ra', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'Lb', type: 'local-candidate', candidateType: 'relay' },
    { id: 'Rb', type: 'remote-candidate', candidateType: 'relay' },
    { id: 'D1', type: 'data-channel', label: 'media', bytesSent: 234962, state: 'open' },
  ]
  // The spec's RTCSctpTransportStats (Chrome doesn't expose it).
  if (o.sctp) out.push({ id: 'S1', type: 'sctp-transport', congestionWindow: 120000, receiverWindow: 262144, smoothedRoundTripTime: 0.031, unackData: 12, mtu: 1191 })
  return out
}

/** Firefox: no transport report naming the pair; the pair is flagged `selected`. */
function firefox(o: { rtt?: number; relay?: boolean } = {}): Map<string, StatsRecord> {
  const rs: StatsRecord[] = [
    { id: 'a', type: 'candidate-pair', nominated: true, selected: false, state: 'succeeded', currentRoundTripTime: 0.9, localCandidateId: 'l2', remoteCandidateId: 'r2' },
    {
      id: 'b',
      type: 'candidate-pair',
      nominated: true,
      selected: true,
      state: 'succeeded',
      bytesSent: 1000,
      bytesReceived: 2000,
      currentRoundTripTime: o.rtt ?? 0.04,
      totalRoundTripTime: 0.4,
      responsesReceived: 10,
      localCandidateId: 'l1',
      remoteCandidateId: 'r1',
    },
    { id: 'l1', type: 'local-candidate', candidateType: 'host' },
    { id: 'r1', type: 'remote-candidate', candidateType: o.relay ? 'relay' : 'host' },
    { id: 'l2', type: 'local-candidate', candidateType: 'host' },
    { id: 'r2', type: 'remote-candidate', candidateType: 'host' },
  ]
  // Map#forEach passes the value first, as RTCStatsReport does.
  return new Map(rs.map((r) => [r.id, r]))
}

describe('parseLinkStats', () => {
  it('Chrome: the pair the transport selected', () => {
    const r = parseLinkStats(chrome())!
    expect(r.pairId).toBe('CPsel')
    expect(r.currentRttMs).toBe(1)
    expect(r.totalRttS).toBe(0.002)
    expect(r.responsesReceived).toBe(3)
    expect(r.bytesSent).toBe(1882145)
    expect(r.relayed).toBe(false)
    expect(r.cwnd).toBeNull() // Chrome has no sctp-transport report
  })
  it('Chrome: relay candidate, and the congestion window when an SCTP report is present', () => {
    const r = parseLinkStats(chrome({ relay: true, sctp: true }))!
    expect(r.relayed).toBe(true)
    expect(r.cwnd).toBe(120000)
  })
  it('Firefox: the pair flagged selected', () => {
    const r = parseLinkStats(firefox({ relay: true }))!
    expect(r.pairId).toBe('b')
    expect(r.currentRttMs).toBe(40)
    expect(r.bytesReceived).toBe(2000)
    expect(r.relayed).toBe(true)
  })
  it('no selected pair (still connecting, or closed): null', () => {
    expect(parseLinkStats([{ id: 'x', type: 'candidate-pair', state: 'in-progress' }])).toBeNull()
    expect(parseLinkStats([])).toBeNull()
  })
  it('unknown candidate types: relayed unknown', () => {
    expect(parseLinkStats([{ id: 'p', type: 'candidate-pair', selected: true }])!.relayed).toBeNull()
  })
})

describe('LinkStatsTracker', () => {
  it('averages the STUN round trips between polls, and keeps a windowed-minimum baseline', () => {
    const t = new LinkStatsTracker(120_000, RTT_STALE_MS)
    let total = 0.002
    let n = 3
    const poll = (now: number, rttMs: number | null, bytesSent = 0) => {
      if (rttMs !== null) {
        total += rttMs / 1000
        n++
      }
      return t.update(parseLinkStats(chrome({ totalRtt: total, responses: n, rtt: (rttMs ?? 1) / 1000, bytesSent }))!, now)
    }
    // First report: the current RTT.
    expect(poll(0, null).rttMs).toBe(1)
    const s = poll(2000, 20, 250_000)
    expect(s).toMatchObject({ baselineMs: 1, fresh: true })
    expect(s.rttMs).toBeCloseTo(20)
    // 250 kB in 2 s = 1000 kbps.
    expect(s.sendKbps).toBeCloseTo(1000)
    expect(poll(4000, 22, 750_000).sendKbps).toBeCloseTo(2000)
    // A poll without a new STUN response keeps the last RTT.
    expect(poll(6000, null, 500_000)).toMatchObject({ rttMs: 22, fresh: true })
    // Two responses in one interval: their average.
    total += 0.1
    n++
    expect(poll(8000, 100).rttMs).toBeCloseTo(100)
  })

  it('goes stale when the RTT stops refreshing', () => {
    const t = new LinkStatsTracker()
    t.update(parseLinkStats(chrome({ responses: 3, totalRtt: 0.002 }))!, 0)
    t.update(parseLinkStats(chrome({ responses: 4, totalRtt: 0.012 }))!, 2000)
    expect(t.current(2000 + RTT_STALE_MS)!.fresh).toBe(true)
    expect(t.update(parseLinkStats(chrome({ responses: 4, totalRtt: 0.012 }))!, 2001 + RTT_STALE_MS).fresh).toBe(false)
    expect(t.current(3000 + RTT_STALE_MS)!.fresh).toBe(false)
  })

  it('the baseline forgets samples older than its window', () => {
    const t = new LinkStatsTracker(10_000)
    let s: LinkStats | null = null
    // Reports without the totals (current RTT only), one every 3 s.
    ;[5, 50, 60, 70, 80, 90, 100].forEach(
      (ms, i) => (s = t.update({ ...parseLinkStats(chrome({ rtt: ms / 1000 }))!, totalRttS: null, responsesReceived: i + 1 }, i * 3000)),
    )
    // At 18 s the window holds the samples from 9 s on: 70, 80, 90, 100.
    expect(s!.baselineMs).toBe(70)
    expect(s!.rttMs).toBe(100)
  })

  it('a new selected pair starts the deltas again', () => {
    const t = new LinkStatsTracker()
    t.update(parseLinkStats(chrome({ responses: 10, totalRtt: 1 }))!, 0)
    const other = { ...parseLinkStats(chrome({ responses: 2, totalRtt: 0.05, rtt: 0.025 }))!, pairId: 'new' }
    expect(t.update(other, 2000).rttMs).toBe(25) // not a negative delta
  })
})

describe('pathInflation', () => {
  const link = (rttMs: number, baselineMs: number, o: Partial<LinkStats> = {}): LinkStats => ({
    rttMs,
    baselineMs,
    samples: 10,
    fresh: true,
    sendKbps: null,
    recvKbps: null,
    relayed: false,
    cwnd: null,
    ...o,
  })
  it('threshold: max(floor, half the baseline)', () => {
    expect(rttInflationThreshold(20, 40)).toBe(40)
    expect(rttInflationThreshold(200, 40)).toBe(100)
  })
  it('inflated when every fresh connection of the pair is', () => {
    expect(pathInflation([link(80, 20), link(90, 21)], 40)).toEqual({ inflationMs: 60, inflated: true })
    expect(pathInflation([link(30, 20), link(90, 21)], 40)).toEqual({ inflationMs: 10, inflated: false })
    // Long paths need proportionally more: 120 ms over a 200 ms baseline is under half.
    expect(pathInflation([link(290, 200)], 40)!.inflated).toBe(false)
    expect(pathInflation([link(310, 200)], 40)!.inflated).toBe(true)
  })
  it('stale connections, or too little history, give no signal', () => {
    expect(pathInflation([link(300, 20, { fresh: false })], 40)).toBeNull()
    expect(pathInflation([link(300, 20, { samples: 2 })], 40)).toBeNull()
    expect(pathInflation([null, link(300, 20, { rttMs: null })], 40)).toBeNull()
    // A stale lane doesn't veto a fresh one.
    expect(pathInflation([link(300, 20), link(20, 20, { fresh: false })], 40)!.inflated).toBe(true)
  })
})
