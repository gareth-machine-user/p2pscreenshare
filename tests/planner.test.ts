import { describe, expect, it } from 'vitest'
import { emptyTopology, type PlannerConfig, type PlannerPeer, type PlanResult } from '../src/topology/model'
import { plan } from '../src/topology/planner'

const HOST = 'H'

function config(over: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    hostId: HOST,
    k: 4,
    m: 1,
    stripeKbps: 625,
    hostUploadKbps: 5000,
    headroom: 0.8,
    maxFanout: 12,
    minUptimeMsForRelay: 0,
    switchGain: 1,
    ...over,
  }
}

function makePeers(n: number, seed = 7): PlannerPeer[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32)
  const caps = [300, 1000, 2500, 8000, 30000]
  return Array.from({ length: n }, (_, i) => ({
    id: `p${String(i).padStart(3, '0')}`,
    capacityKbps: caps[Math.floor(rnd() * caps.length)],
    joinedAt: i,
    failures: 0,
    avoid: [],
  }))
}

function checkInvariants(r: PlanResult, peers: PlannerPeer[], cfg: PlannerConfig) {
  const S = cfg.k + cfg.m
  for (const p of peers) {
    const ps = r.topology.parents[p.id]
    expect(ps).toHaveLength(S)
    for (let s = 0; s < S; s++) {
      const parent = ps[s]
      // every peer receives every stripe
      expect(parent).not.toBeNull()
      // a non-host parent must be a relay homed in that stripe
      if (parent !== HOST) expect(r.topology.home[parent!]).toBe(s)
      // walking up reaches the host (no cycles)
      let cur: string | null = p.id
      const seen = new Set<string>()
      while (cur !== HOST) {
        expect(seen.has(cur!)).toBe(false)
        seen.add(cur!)
        cur = r.topology.parents[cur!][s]
      }
    }
  }
  // fan-out within capacity when there is no overcommit
  if (r.overcommitted === 0) {
    for (const p of peers) {
      const h = r.topology.home[p.id]
      if (h == null) continue
      const kids = peers.filter((c) => r.topology.parents[c.id][h] === p.id).length
      expect(kids).toBeLessThanOrEqual(r.slots[p.id])
    }
  }
}

describe('planner', () => {
  it('builds valid striped trees', () => {
    const cfg = config({ maxFanout: 16 })
    const peers = makePeers(200)
    const r = plan(peers, emptyTopology(), cfg, 1000)
    checkInvariants(r, peers, cfg)
    expect(r.overcommitted).toBe(0)
    const maxDepth = Math.max(...Object.values(r.depth).flat())
    expect(maxDepth).toBeLessThanOrEqual(4)
  })

  it('each peer relays in at most one stripe and homes are balanced', () => {
    const cfg = config()
    const peers = makePeers(200)
    const r = plan(peers, emptyTopology(), cfg, 1000)
    const supply = new Array(5).fill(0)
    for (const p of peers) {
      const h = r.topology.home[p.id]
      if (h != null) supply[h] += r.slots[p.id]
      for (let s = 0; s < 5; s++) {
        const kids = peers.filter((c) => r.topology.parents[c.id][s] === p.id).length
        if (s !== h) expect(kids).toBe(0)
      }
    }
    expect(Math.max(...supply) - Math.min(...supply)).toBeLessThanOrEqual(cfg.maxFanout)
  })

  it('k=1 m=0 is a single tree', () => {
    const cfg = config({ k: 1, m: 0, stripeKbps: 2500 })
    const peers = makePeers(50)
    const r = plan(peers, emptyTopology(), cfg, 1000)
    checkInvariants(r, peers, cfg)
  })

  it('is stable: replanning with no input change produces no changes', () => {
    const cfg = config()
    const peers = makePeers(120)
    const r1 = plan(peers, emptyTopology(), cfg, 1000)
    const r2 = plan(peers, r1.topology, cfg, 2000)
    expect(r2.changes).toEqual([])
  })

  it('a departing relay only disturbs its own children', () => {
    const cfg = config()
    const peers = makePeers(120)
    const r1 = plan(peers, emptyTopology(), cfg, 1000)
    const victim = peers.find((p) => r1.topology.home[p.id] != null && r1.depth[p.id][r1.topology.home[p.id]!] === 1)!
    const remaining = peers.filter((p) => p !== victim)
    const r2 = plan(remaining, r1.topology, cfg, 2000)
    checkInvariants(r2, remaining, cfg)
    const orphans = remaining.filter((p) => r1.topology.parents[p.id].includes(victim.id)).length
    expect(orphans).toBeGreaterThan(0)
    // Allow some cascade (re-placing a relay moves its subtree position), but bounded.
    expect(r2.changes.length).toBeLessThanOrEqual(orphans * 3)
  })

  it('respects unreachable pairs', () => {
    const cfg = config({ k: 1, m: 0, stripeKbps: 2500, hostUploadKbps: 2500 })
    const peers: PlannerPeer[] = [
      { id: 'a', capacityKbps: 20000, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'b', capacityKbps: 0, joinedAt: 1, failures: 0, avoid: ['a'] },
      { id: 'c', capacityKbps: 20000, joinedAt: 2, failures: 0, avoid: [] },
    ]
    const r = plan(peers, emptyTopology(), cfg, 1000)
    expect(r.topology.parents.b[0]).not.toBe('a')
    checkInvariants(r, peers, cfg)
  })

  it('new peers start as leaves until they have uptime', () => {
    const cfg = config({ minUptimeMsForRelay: 5000 })
    const peers = makePeers(10)
    const r = plan(peers, emptyTopology(), cfg, 1000)
    expect(Object.values(r.topology.home).every((h) => h === null)).toBe(true)
    expect(r.overcommitted).toBeGreaterThan(0) // host alone cannot serve 10 peers x 5 stripes
  })
})
