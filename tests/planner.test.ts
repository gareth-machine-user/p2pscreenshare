import { describe, expect, it } from 'vitest'
import { emptyTopology, subtree, type PlannerConfig, type PlannerPeer, type PlanResult } from '../src/topology/model'
import { plan } from '../src/topology/planner'
import { LATE_PARENT_FOR_MS, LateParentTracker } from '../src/topology/policy'

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
    rttSwitchMs: 40,
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
      if (parent !== HOST) expect(r.topology.homes[parent]).toContain(s)
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
    // at most m homes (one when there is no parity): a failed relay costs at most what parity covers
    expect(r.topology.homes[p.id].length).toBeLessThanOrEqual(Math.max(1, cfg.m))
    expect(new Set(r.topology.homes[p.id]).size).toBe(r.topology.homes[p.id].length)
  }
  // fan-out within capacity when there is no overcommit
  if (r.overcommitted === 0) {
    for (const p of peers) {
      const kids = r.topology.homes[p.id].reduce((n, h) => n + peers.filter((c) => r.topology.parents[c.id][h] === p.id).length, 0)
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

  it('with plenty of relays, each peer relays in at most one stripe and homes are balanced', () => {
    const cfg = config()
    const peers = makePeers(200)
    const r = plan(peers, emptyTopology(), cfg, 1000)
    const supply = new Array(5).fill(0)
    for (const p of peers) {
      expect(r.topology.homes[p.id].length).toBeLessThanOrEqual(1)
      const h = r.topology.homes[p.id][0]
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
    const victim = peers.find((p) => r1.topology.homes[p.id].length > 0 && r1.depth[p.id][r1.topology.homes[p.id][0]] === 1)!
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
    expect(Object.values(r.topology.homes).every((h) => h.length === 0)).toBe(true)
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
    expect(r.topology.homes.b).toEqual([])
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
      homes: { a: [0], b: [0], leaf: [] },
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
    const current = { parents: {}, homes: { a: [0], c: [2] } }
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
    for (const d of r.topology.homes.D) expect(r.topology.parents.D[d]).not.toBeNull()
    expect(r.topology.homes.D.length).toBeGreaterThan(0)
  })

  describe('fewer relays than stripes (4+2)', () => {
    const cfg = config({ k: 4, m: 2, rootSlots: 6, maxFanout: 16 })
    const viewers = (n: number, slots = 8): PlannerPeer[] =>
      Array.from({ length: n }, (_, i) => ({ id: `v${i}`, slots, joinedAt: i, failures: 0, avoid: [] }))
    const rootEdges = (r: PlanResult, peers: PlannerPeer[]) =>
      peers.reduce((n, p) => n + r.topology.parents[p.id].filter((x) => x === HOST).length, 0)
    /** Stripes a peer still gets when `gone` vanishes (its subtree loses that stripe). */
    const survives = (r: PlanResult, peer: string, gone: string) =>
      r.topology.parents[peer].filter((par, s) => {
        let cur: string | null = par
        for (let i = 0; i < 10 && cur !== null && cur !== HOST; i++) {
          if (cur === gone) return false
          cur = r.topology.parents[cur][s]
        }
        return cur === HOST
      }).length

    it('2 viewers on a presenter with room for one copy: two homes each, no overcommit, ≥ k stripes each', () => {
      const peers = viewers(2)
      const r = plan(peers, emptyTopology(), cfg, 1000)
      checkInvariants(r, peers, cfg, false)
      for (const p of peers) expect(r.topology.homes[p.id]).toHaveLength(2)
      expect(r.overcommitted).toBe(0)
      expect(rootEdges(r, peers)).toBe(6)
      // Each relays its two homes to the other; the root's last slots carry the unrelayed parity.
      for (const p of peers) expect(r.topology.parents[p.id].filter((x) => x !== null).length).toBeGreaterThanOrEqual(cfg.k)
    })

    it('2 viewers on a presenter with room for two copies get everything from it directly', () => {
      const c = { ...cfg, rootSlots: 12 }
      const peers = viewers(2)
      const r = plan(peers, emptyTopology(), c, 1000)
      checkInvariants(r, peers, c)
      expect(rootEdges(r, peers)).toBe(12)
    })

    it('3 viewers: every stripe has a relay, 1.5× at the root', () => {
      const peers = viewers(3)
      const r = plan(peers, emptyTopology(), cfg, 1000)
      checkInvariants(r, peers, cfg)
      const relayed = new Set(peers.flatMap((p) => r.topology.homes[p.id]))
      expect(relayed.size).toBe(6)
      expect(rootEdges(r, peers)).toBe(6)
      for (const p of peers) for (const o of peers) if (o !== p) expect(survives(r, p.id, o.id)).toBeGreaterThanOrEqual(cfg.k)
    })

    it('6 or more viewers: one home each', () => {
      const peers = viewers(8)
      const r = plan(peers, emptyTopology(), cfg, 1000)
      checkInvariants(r, peers, cfg)
      for (const p of peers) expect(r.topology.homes[p.id]).toHaveLength(1)
    })

    it('keeps extra homes across replans, and gives them up when a new relay can take one', () => {
      const peers = viewers(3)
      const r1 = plan(peers, emptyTopology(), cfg, 1000)
      expect(plan(peers, r1.topology, cfg, 2000).changes).toEqual([])
      const more = [...peers, ...viewers(6).slice(3)]
      let t = r1.topology
      for (let i = 0; i < 3; i++) t = plan(more, t, cfg, 3000 + i * 1000).topology
      for (const p of more) expect(t.homes[p.id]).toHaveLength(1)
      // The first homes stay put.
      for (const p of peers) expect(t.homes[p.id][0]).toBe(r1.topology.homes[p.id][0])
    })

    it('a relay with a single slot takes no extra home', () => {
      const peers = [...viewers(2, 1)]
      const r = plan(peers, emptyTopology(), cfg, 1000)
      for (const p of peers) expect(r.topology.homes[p.id]).toHaveLength(1)
    })

    it('without parity a relay keeps a single home', () => {
      const c = config({ k: 4, m: 0, rootSlots: 4 })
      const peers = viewers(2)
      const r = plan(peers, emptyTopology(), c, 1000)
      for (const p of peers) expect(r.topology.homes[p.id]).toHaveLength(1)
    })
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

describe('subtree', () => {
  it('lists descendants in one stripe, excluding the root, and survives cycles', () => {
    const t = { parents: { a: [HOST, HOST], b: ['a', HOST], c: ['b', 'a'], x: ['y', null], y: ['x', null] }, homes: {} }
    expect(subtree(t, 'a', 0).sort()).toEqual(['b', 'c'])
    expect(subtree(t, 'a', 1)).toEqual(['c'])
    expect(subtree(t, HOST, 1).sort()).toEqual(['a', 'b', 'c'])
    expect(subtree(t, 'x', 0)).toEqual(['y'])
  })
})

describe('LateParentTracker', () => {
  it('averages excess lateness over children and evicts a parent late for too long, once', () => {
    const late = new LateParentTracker()
    const samples = [
      { parent: 'p', stripe: 1, lateMs: 400, parentLateMs: 100 },
      { parent: 'p', stripe: 1, lateMs: 150, parentLateMs: 100 },
      { parent: 'q', stripe: 0, lateMs: 50, parentLateMs: 100 },
    ]
    expect(late.update(samples, 0)).toEqual([])
    expect(late.get('p', 1)).toBe(175)
    expect(late.get('q', 0)).toBe(0)
    expect(late.update(samples, LATE_PARENT_FOR_MS - 1)).toEqual([])
    expect(late.update(samples, LATE_PARENT_FOR_MS)).toEqual([{ parent: 'p', stripe: 1 }])
    expect(late.update(samples, LATE_PARENT_FOR_MS + 1)).toEqual([])
    // Back under the limit (or unmeasured) resets the clock.
    late.update([], LATE_PARENT_FOR_MS + 2)
    expect(late.update(samples, 2 * LATE_PARENT_FOR_MS)).toEqual([])
  })
})
