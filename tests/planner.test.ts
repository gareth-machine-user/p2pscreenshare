import { describe, expect, it } from 'vitest'
import { emptyTopology, type PlannerConfig, type PlannerPeer, type PlanResult } from '../src/topology/model'
import { plan } from '../src/topology/planner'

const HOST = 'H'

function config(over: Partial<PlannerConfig> = {}): PlannerConfig {
  return {
    hostId: HOST,
    k: 4,
    m: 1,
    rootSlots: 6, // 5000 kbps * 0.8 / 625 kbps stripes
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
    // Offered slots: 80% of upload / 625 kbps stripes.
    slots: Math.floor((caps[Math.floor(rnd() * caps.length)] * 0.8) / 625),
    joinedAt: i,
    failures: 0,
    avoid: [],
  }))
}

/**
 * Structural invariants. Every attachment hangs off a relay homed in that stripe and its parent
 * chain reaches the host (no cycles, no dead branches); every peer receives at least k stripes, or
 * every stripe with `allStripes` (no parity shedding expected).
 */
function checkInvariants(r: PlanResult, peers: PlannerPeer[], cfg: PlannerConfig, allStripes = true) {
  const S = cfg.k + cfg.m
  for (const p of peers) {
    const ps = r.topology.parents[p.id]
    expect(ps).toHaveLength(S)
    let live = 0
    for (let s = 0; s < S; s++) {
      const parent = ps[s]
      if (allStripes) expect(parent, `${p.id} stripe ${s}`).not.toBeNull()
      if (parent === null) continue
      // a non-host parent must be a relay homed in that stripe
      if (parent !== HOST) expect(r.topology.home[parent]).toBe(s)
      // walking up reaches the host (no cycles, no unattached ancestor)
      let cur: string | null = p.id
      const seen = new Set<string>()
      while (cur !== HOST) {
        expect(cur, `${p.id} stripe ${s}: chain breaks`).not.toBeNull()
        expect(seen.has(cur!)).toBe(false)
        seen.add(cur!)
        cur = r.topology.parents[cur!][s]
      }
      live++
    }
    expect(live, `${p.id} live stripes`).toBeGreaterThanOrEqual(cfg.k)
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
    const cfg = config({ k: 1, m: 0, rootSlots: 1 })
    const peers = makePeers(50).map((p) => ({ ...p, slots: Math.floor(p.slots / 4) }))
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
    const cfg = config({ k: 1, m: 0, rootSlots: 1 })
    const peers: PlannerPeer[] = [
      { id: 'a', slots: 6, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'b', slots: 0, joinedAt: 1, failures: 0, avoid: ['a'] },
      { id: 'c', slots: 6, joinedAt: 2, failures: 0, avoid: [] },
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

  it('plans within offered slots: a peer offering none never relays', () => {
    const cfg = config({ k: 2, m: 1, rootSlots: 3, maxFanout: 16 })
    const peers: PlannerPeer[] = [
      { id: 'a', slots: 2, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'b', slots: 0, joinedAt: 1, failures: 0, avoid: [] },
      { id: 'c', slots: 40, joinedAt: 2, failures: 0, avoid: [] },
      { id: 'd', slots: 40, joinedAt: 2, failures: 0, avoid: [] },
      { id: 'e', slots: 40, joinedAt: 2, failures: 0, avoid: [] },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `l${i}`, slots: 0, joinedAt: 3 + i, failures: 0, avoid: [] })),
    ]
    const r = plan(peers, emptyTopology(), cfg, 1000)
    checkInvariants(r, peers, cfg)
    expect(r.topology.home.b).toBeNull()
    expect(r.slots.a).toBe(2)
    expect(r.slots.c).toBe(16) // capped by maxFanout
    // Feasible, so no relay gets more children than it offered (checked by checkInvariants).
    expect(r.overcommitted).toBe(0)
  })

  it('breaks ties between equally deep parents by RTT', () => {
    const rtt: Record<string, number> = { 'x:near': 10, 'x:far': 90, 'y:near': 80, 'y:far': 15 }
    const cfg = config({
      k: 1,
      m: 0,
      rootSlots: 2,
      rtt: (a, b) => rtt[`${b}:${a}`] ?? rtt[`${a}:${b}`] ?? null,
    })
    const peers: PlannerPeer[] = [
      { id: 'far', slots: 4, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'near', slots: 4, joinedAt: 1, failures: 0, avoid: [] },
      { id: 'x', slots: 0, joinedAt: 2, failures: 0, avoid: [] },
      { id: 'y', slots: 0, joinedAt: 3, failures: 0, avoid: [] },
    ]
    const r = plan(peers, emptyTopology(), cfg, 1000)
    checkInvariants(r, peers, cfg)
    // Both relays hang off the root (depth 1); each leaf picks the closer one.
    expect(r.topology.parents.x[0]).toBe('near')
    expect(r.topology.parents.y[0]).toBe('far')
  })

  it('lateness counts against a parent like extra RTT', () => {
    const cfg = config({
      k: 1,
      m: 0,
      rootSlots: 2,
      rtt: () => 20,
      lateness: (parent) => (parent === 'slow' ? 200 : 0),
    })
    const peers: PlannerPeer[] = [
      { id: 'slow', slots: 4, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'fast', slots: 4, joinedAt: 1, failures: 0, avoid: [] },
      { id: 'leaf', slots: 0, joinedAt: 2, failures: 0, avoid: [] },
    ]
    expect(plan(peers, emptyTopology(), cfg, 1000).topology.parents.leaf[0]).toBe('fast')
  })

  it('moves a peer to a much closer parent at the same depth, but not for a small gain', () => {
    const base = { k: 1, m: 0, rootSlots: 2 }
    const peers: PlannerPeer[] = [
      { id: 'a', slots: 4, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'b', slots: 4, joinedAt: 1, failures: 0, avoid: [] },
      { id: 'leaf', slots: 0, joinedAt: 2, failures: 0, avoid: [] },
    ]
    const current = {
      parents: { a: ['H'], b: ['H'], leaf: ['a'] },
      home: { a: 0, b: 0, leaf: null },
    }
    const rttTo = (aMs: number, bMs: number) => (x: string, y: string) => {
      const other = x === 'leaf' ? y : y === 'leaf' ? x : null
      return other === 'a' ? aMs : other === 'b' ? bMs : 5
    }
    // 30 ms closer: within the 40 ms hysteresis, stay.
    expect(plan(peers, current, config({ ...base, rtt: rttTo(60, 30) }), 1000).topology.parents.leaf[0]).toBe('a')
    // 100 ms closer: move.
    expect(plan(peers, current, config({ ...base, rtt: rttTo(130, 30) }), 1000).topology.parents.leaf[0]).toBe('b')
  })

  it('does not overload the publisher for a stripe that parity covers', () => {
    // Stripe relays for 0 and 2 only: stripe 1 has nothing but the root's single slot.
    const cfg = config({ k: 2, m: 1, rootSlots: 3 })
    const current = { parents: {}, home: { a: 0, c: 2 } as Record<string, number | null> }
    const peers: PlannerPeer[] = [
      { id: 'a', slots: 16, joinedAt: 0, failures: 0, avoid: [] },
      { id: 'c', slots: 16, joinedAt: 1, failures: 0, avoid: [] },
      ...Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, slots: 0, joinedAt: 2 + i, failures: 0, avoid: [] })),
    ]
    const r = plan(peers, current, cfg, 1000)
    const rootKids = (s: number) => peers.filter((p) => r.topology.parents[p.id][s] === 'H').length
    // The root stays within its per-stripe share instead of feeding stripe 1 to everyone...
    expect(rootKids(1)).toBeLessThanOrEqual(1)
    // ...and everyone still gets at least k stripes.
    for (const p of peers) expect(r.topology.parents[p.id].filter((x) => x !== null).length).toBeGreaterThanOrEqual(2)
  })

  it('never sheds a relay from the stripe it feeds its children', () => {
    // D relays stripe 2 off an overcommitted root; shedding D's stripe 2 would strand L there.
    const cfg = config({ k: 2, m: 1, rootSlots: 3, maxFanout: 8 })
    const P = (id: string, slots: number, joinedAt: number, avoid: string[] = []): PlannerPeer => ({
      id,
      slots,
      joinedAt,
      failures: 0,
      avoid,
    })
    const peers = [P('A', 8, 0), P('B', 8, 1), P('C', 4, 2), P('D', 3, 3, ['C']), P('L', 0, 4, ['B', 'C'])]
    const r = plan(peers, emptyTopology(), cfg, 1000)
    checkInvariants(r, peers, cfg, false)
    const d = r.topology.home.D!
    expect(r.topology.parents.D[d]).not.toBeNull()
  })

  it('keeps its invariants on random inputs', () => {
    for (let seed = 1; seed <= 300; seed++) {
      let x = seed
      const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32)
      const int = (n: number) => Math.floor(rnd() * n)
      const k = 1 + int(3)
      const m = int(3)
      const cfg = config({ k, m, rootSlots: k + m + int(4), maxFanout: 2 + int(8), switchGain: 1 })
      const n = 1 + int(25)
      const ids = Array.from({ length: n }, (_, i) => `p${i}`)
      const peers: PlannerPeer[] = ids.map((id, i) => ({
        id,
        slots: int(3) === 0 ? 0 : int(10),
        joinedAt: i,
        failures: int(3),
        avoid: ids.filter((o) => o !== id && rnd() < 0.15),
      }))
      const r1 = plan(peers, emptyTopology(), cfg, 1000)
      checkInvariants(r1, peers, cfg, false)
      // Replan after some churn on top of the previous topology.
      const next = peers.filter(() => rnd() > 0.2)
      const r2 = plan(next, r1.topology, cfg, 2000)
      checkInvariants(r2, next, cfg, false)
    }
  })
})
