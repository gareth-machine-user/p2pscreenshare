import type { ParentChange, PlannerConfig, PlannerPeer, PlanResult, Topology } from './model'
import { stripeCount } from './model'

/**
 * Computes a striped multi-tree topology (SplitStream-style) for one channel. Its publisher runs it,
 * with itself as the root and the slots its subscribers offer for this channel as capacity.
 *
 * - Each peer with spare upload relays in exactly one "home" stripe and is a leaf in the others.
 * - Home stripes are balanced by total relay capacity.
 * - Within a stripe, stronger relays sit closer to the root; leaves fill the shallowest free slots.
 *   Among equally shallow parents, the closest (RTT plus lateness) wins.
 * - Existing parents are kept when they are nearly as good (hysteresis), to limit churn.
 *
 * Pure and deterministic: same inputs -> same output.
 */
export function plan(peersIn: PlannerPeer[], current: Topology, cfg: PlannerConfig, now: number): PlanResult {
  const S = stripeCount(cfg)
  const peers = [...peersIn].sort((a, b) => a.joinedAt - b.joinedAt || cmp(a.id, b.id))
  const byId = new Map(peers.map((p) => [p.id, p]))

  // 1. Relay slots per peer: what it offered for this channel, capped.
  const slots: Record<string, number> = {}
  for (const p of peers) slots[p.id] = Math.max(0, Math.min(cfg.maxFanout, Math.floor(p.slots) || 0))
  const score = (p: PlannerPeer) => slots[p.id] / (1 + p.failures)
  const wasRelay = (p: PlannerPeer) => current.home[p.id] != null && current.home[p.id]! < S
  const eligible = peers.filter(
    (p) => slots[p.id] >= 1 && (wasRelay(p) || now - p.joinedAt >= cfg.minUptimeMsForRelay),
  )

  // 2. Home stripes: keep existing assignments, give new relays to the stripe with least supply.
  const home: Record<string, number | null> = {}
  for (const p of peers) home[p.id] = null
  const supply = new Array<number>(S).fill(0)
  const newRelays: PlannerPeer[] = []
  for (const p of eligible) {
    const h = current.home[p.id]
    if (h != null && h < S) {
      home[p.id] = h
      supply[h] += slots[p.id]
    } else {
      newRelays.push(p)
    }
  }
  newRelays.sort((a, b) => score(b) - score(a) || cmp(a.id, b.id))
  for (const p of newRelays) {
    const s = argmin(supply)
    home[p.id] = s
    supply[s] += slots[p.id]
  }

  // 3. Root slots per stripe (at least one each: the publisher must emit every stripe).
  const hostSlots = Math.max(S, Math.floor(cfg.rootSlots) || 0)
  // Fixed split (not supply-dependent) so membership changes don't reshuffle host slots.
  const hostPerStripe = [...Array(S).keys()].map((s) => Math.floor(hostSlots / S) + (s < hostSlots % S ? 1 : 0))

  // 4. Build each stripe tree.
  const parents: Record<string, (string | null)[]> = {}
  const depth: Record<string, number[]> = {}
  for (const p of peers) {
    parents[p.id] = new Array(S).fill(null)
    depth[p.id] = new Array(S).fill(0)
  }
  let overcommitted = 0
  /** Attachments that overcommit the root (the publisher), by stripe. */
  const rootOver: { peer: string; stripe: number }[] = []

  for (let s = 0; s < S; s++) {
    const remaining = new Map<string, number>([[cfg.hostId, hostPerStripe[s]]])
    const capOf = new Map<string, number>([[cfg.hostId, hostPerStripe[s]]])
    const load = new Map<string, number>([[cfg.hostId, 0]])
    const nodeDepth = new Map<string, number>([[cfg.hostId, 0]])
    const placedRelays: string[] = [cfg.hostId]

    // Existing relays keep their level (shallowest first) so a newcomer doesn't displace a whole
    // subtree; new relays are then placed strongest-first.
    const curDepth = currentDepths(current, s, cfg.hostId, (id) => byId.has(id) && home[id] === s)
    const relays = peers
      .filter((p) => home[p.id] === s)
      .sort(
        (a, b) =>
          (curDepth.get(a.id) ?? Infinity) - (curDepth.get(b.id) ?? Infinity) ||
          score(b) - score(a) ||
          cmp(a.id, b.id),
      )
    const relaySet = new Set(relays.map((p) => p.id))
    const leaves = peers.filter((p) => !relaySet.has(p.id))

    const canLink = (child: PlannerPeer, parentId: string) => {
      if (parentId === child.id) return false
      if (child.avoid.includes(parentId)) return false
      const parent = byId.get(parentId)
      return !parent || !parent.avoid.includes(child.id)
    }

    const starved = (id: string) => byId.get(id)?.starved?.includes(s) ?? false

    /** Distance from a parent to a child: RTT plus the parent's lateness on this stripe. */
    const cost = (parentId: string, childId: string): number | null => {
      const rtt = cfg.rtt?.(parentId, childId) ?? null
      if (rtt === null) return null
      return rtt + (cfg.lateness?.(parentId, s) ?? 0)
    }

    const bestFree = (p: PlannerPeer): string | null => {
      let best: string | null = null
      for (const id of placedRelays) {
        if ((remaining.get(id) ?? 0) <= 0 || !canLink(p, id) || starved(id)) continue
        if (best === null || better(p.id, id, best)) best = id
      }
      return best
    }

    /** Current parent, if it is placed, has room, and is not much worse than the best option. */
    const keepable = (p: PlannerPeer, best: string | null): string | null => {
      const cur = current.parents[p.id]?.[s] ?? null
      if (cur === null || !nodeDepth.has(cur) || (remaining.get(cur) ?? 0) <= 0 || !canLink(p, cur)) return null
      if (best === null || best === cur) return cur
      const dCur = nodeDepth.get(cur)!
      const dBest = nodeDepth.get(best)!
      if (dCur > dBest + cfg.switchGain) return null
      // A parent no deeper that is much closer is worth a move.
      const cCur = cost(cur, p.id)
      const cBest = cost(best, p.id)
      if (dBest <= dCur && cCur !== null && cBest !== null && cBest + (cfg.rttSwitchMs ?? 40) < cCur) return null
      return cur
    }

    const attach = (p: PlannerPeer, chosen: string | null) => {
      parents[p.id][s] = chosen
      placed.add(p.id)
      if (chosen === null) return
      remaining.set(chosen, (remaining.get(chosen) ?? 0) - 1)
      load.set(chosen, load.get(chosen)! + 1)
      const d = nodeDepth.get(chosen)! + 1
      depth[p.id][s] = d
      if (relaySet.has(p.id)) {
        nodeDepth.set(p.id, d)
        remaining.set(p.id, slots[p.id])
        capOf.set(p.id, slots[p.id])
        load.set(p.id, 0)
        placedRelays.push(p.id)
      }
    }

    /** Pass 1: keep a still-valid current attachment. */
    const tryKeep = (p: PlannerPeer) => {
      const cur = keepable(p, bestFree(p))
      if (cur !== null) attach(p, cur)
    }

    /** Pass 2: place anywhere (preferring the current parent), overcommitting if necessary. */
    const placeAny = (p: PlannerPeer) => {
      if (placed.has(p.id)) return
      const best = bestFree(p)
      let chosen = keepable(p, best) ?? best
      if (chosen === null) {
        const cur = current.parents[p.id]?.[s] ?? null
        if (cur !== null && nodeDepth.has(cur) && canLink(p, cur)) {
          // No free capacity anywhere: stay put rather than shuffling overcommitted children.
          chosen = cur
        } else {
          let leastRatio = Infinity
          for (const id of placedRelays) {
            if (!canLink(p, id)) continue
            const ratio = (load.get(id)! + 1) / Math.max(capOf.get(id)!, 0.5)
            if (ratio < leastRatio) {
              leastRatio = ratio
              chosen = id
            }
          }
        }
        if (chosen !== null) overcommitted++
        if (chosen === cfg.hostId) rootOver.push({ peer: p.id, stripe: s })
      }
      attach(p, chosen)
    }

    // For `child`: shallower first, then closer (RTT + lateness), then more spare capacity, then id.
    const better = (child: string, a: string, b: string) => {
      const da = nodeDepth.get(a)!
      const db = nodeDepth.get(b)!
      if (da !== db) return da < db
      const ca = cost(a, child)
      const cb = cost(b, child)
      if (ca !== null && cb !== null && ca !== cb) return ca < cb
      const ra = remaining.get(a)!
      const rb = remaining.get(b)!
      if (ra !== rb) return ra > rb
      return cmp(a, b) < 0
    }

    const placed = new Set<string>()
    relays.forEach(tryKeep)
    ;[...relays].sort((a, b) => score(b) - score(a) || cmp(a.id, b.id)).forEach(placeAny)
    leaves.forEach(tryKeep)
    leaves.forEach(placeAny)
  }

  // 5. Shed root overcommit where parity allows. The publisher's uplink carries every stripe, so
  // overloading it delays all of them for everyone; a peer that still gets k other stripes just
  // decodes from those. (Newest attachments go first.) A relay keeps its home stripe: its children
  // there depend on it. Only stripes whose parent chain reaches the root count as received.
  const reachesRoot = (id: string, s: number): boolean => {
    let cur: string | null = id
    for (let i = 0; i <= peers.length && cur !== null; i++) {
      if (cur === cfg.hostId) return true
      cur = parents[cur]?.[s] ?? null
    }
    return false
  }
  for (const { peer, stripe } of rootOver.reverse()) {
    if (home[peer] === stripe) continue
    let live = 0
    for (let s = 0; s < S; s++) if (reachesRoot(peer, s)) live++
    if (live > cfg.k) {
      parents[peer][stripe] = null
      depth[peer][stripe] = 0
      overcommitted--
    }
  }

  // 6. Diff against the current topology.
  const changes: ParentChange[] = []
  for (const p of peers) {
    for (let s = 0; s < S; s++) {
      const from = current.parents[p.id]?.[s] ?? null
      const to = parents[p.id][s]
      if (from !== to) changes.push({ peer: p.id, stripe: s, from, to })
    }
  }

  return { topology: { parents, home }, changes, depth, overcommitted, slots }
}

function argmin(xs: number[]): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) if (xs[i] < xs[best]) best = i
  return best
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Depth of each relay in the current tree for `stripe`, following only links that remain valid
 * (parent is the host or a still-valid relay of this stripe). Broken chains are omitted.
 */
function currentDepths(
  current: Topology,
  stripe: number,
  hostId: string,
  isValidRelay: (id: string) => boolean,
): Map<string, number> {
  const memo = new Map<string, number>()
  const visit = (id: string, guard: number): number => {
    if (id === hostId) return 0
    if (memo.has(id)) return memo.get(id)!
    if (guard > 64 || !isValidRelay(id)) return Infinity
    const par = current.parents[id]?.[stripe]
    const d = par == null ? Infinity : visit(par, guard + 1) + 1
    memo.set(id, d)
    return d
  }
  for (const id of Object.keys(current.parents)) if (isValidRelay(id)) visit(id, 0)
  for (const [id, d] of memo) if (!Number.isFinite(d)) memo.delete(id)
  return memo
}
