import type { ParentChange, PlannerConfig, PlannerPeer, PlanResult, Topology } from './model'
import { stripeCount } from './model'

/**
 * Computes a striped multi-tree topology (SplitStream-style) for one channel. Its publisher runs it,
 * with itself as the root and the slots its subscribers offer for this channel as capacity.
 *
 * - Each peer with spare upload relays in one "home" stripe and is a leaf in the others. While some
 *   stripe has no relay (fewer relays than stripes), relays take it on as an extra home, up to m
 *   homes each: a relay that fails then costs its children at most m stripes, which parity covers.
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

  // 1. Relay slots per peer: what it offered for this channel, capped.
  const slots: Record<string, number> = {}
  for (const p of peers) slots[p.id] = Math.max(0, Math.min(cfg.maxFanout, Math.floor(p.slots) || 0))
  const score = (p: PlannerPeer) => slots[p.id] / (1 + p.failures)

  // 2. Home stripes.
  const homes = assignHomes(peers, current, cfg, slots, score, now)

  // 3. Root slots per stripe.
  const hostPerStripe = rootSlotsPerStripe(cfg)

  // 4. Build each stripe tree.
  const ctx: PlanContext = {
    cfg,
    current,
    peers,
    byId: new Map(peers.map((p) => [p.id, p])),
    slots,
    homes,
    score,
    parents: {},
    depth: {},
    overcommitted: 0,
    rootOver: [],
  }
  for (const p of peers) {
    ctx.parents[p.id] = new Array(S).fill(null)
    ctx.depth[p.id] = new Array(S).fill(0)
  }
  for (let s = 0; s < S; s++) new StripeBuilder(ctx, s, hostPerStripe[s]).build()

  // 5. Shed root overcommit where parity allows.
  shedRootOvercommit(ctx)

  // 6. Diff against the current topology.
  const changes = diffTopology(peers, current, ctx.parents, S)

  return { topology: { parents: ctx.parents, homes }, changes, depth: ctx.depth, overcommitted: ctx.overcommitted, slots }
}

/** State shared by the planning steps. */
interface PlanContext {
  cfg: PlannerConfig
  current: Topology
  /** Sorted by join time, then id. */
  peers: PlannerPeer[]
  byId: Map<string, PlannerPeer>
  slots: Record<string, number>
  homes: Record<string, number[]>
  score: (p: PlannerPeer) => number
  /** Output, filled stripe by stripe. */
  parents: Record<string, (string | null)[]>
  depth: Record<string, number[]>
  /** Attachments that exceed some parent's estimated capacity. */
  overcommitted: number
  /** Attachments that overcommit the root (the publisher), in placement order. */
  rootOver: { peer: string; stripe: number }[]
}

/**
 * Home stripes: eligible relays (some slots, and either already relaying or subscribed long enough)
 * keep their existing first home; new relays go to the stripe with least supply, strongest first.
 * Then each stripe nobody relays goes to a relay with room for another home (fewer than m homes,
 * and at least one slot per home): preferably the one that had it, else the one with most slots
 * per home. A relay's first home comes first in its list.
 */
function assignHomes(
  peers: PlannerPeer[],
  current: Topology,
  cfg: PlannerConfig,
  slots: Record<string, number>,
  score: (p: PlannerPeer) => number,
  now: number,
): Record<string, number[]> {
  const S = stripeCount(cfg)
  const before = (p: PlannerPeer) => (current.homes[p.id] ?? []).filter((h) => h < S)
  const eligible = peers.filter(
    (p) => slots[p.id] >= 1 && (before(p).length > 0 || now - p.joinedAt >= cfg.minUptimeMsForRelay),
  )
  const homes: Record<string, number[]> = {}
  for (const p of peers) homes[p.id] = []
  const supply = new Array<number>(S).fill(0)
  const newRelays: PlannerPeer[] = []
  for (const p of eligible) {
    const h = current.homes[p.id]?.[0]
    if (h != null && h < S) {
      homes[p.id] = [h]
      supply[h] += slots[p.id]
    } else {
      newRelays.push(p)
    }
  }
  newRelays.sort((a, b) => score(b) - score(a) || cmp(a.id, b.id))
  for (const p of newRelays) {
    const s = argmin(supply)
    homes[p.id] = [s]
    supply[s] += slots[p.id]
  }

  const maxHomes = Math.max(1, cfg.m)
  for (let s = 0; s < S; s++) {
    if (supply[s] > 0) continue
    let best: PlannerPeer | null = null
    let bestKey: [number, number] = [-1, -1]
    for (const p of eligible) {
      const n = homes[p.id].length
      const perHome = Math.floor(slots[p.id] / (n + 1))
      if (n >= maxHomes || perHome < 1) continue
      const key: [number, number] = [before(p).includes(s) ? 1 : 0, perHome]
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
        best = p
        bestKey = key
      }
    }
    if (best) homes[best.id].push(s)
  }
  return homes
}

/** A relay's slots in one of its home stripes: split evenly, the remainder to its lowest stripes. */
function slotsIn(slots: number, homes: number[], s: number): number {
  const n = homes.length
  if (!n) return 0
  const rank = [...homes].sort((a, b) => a - b).indexOf(s)
  return Math.floor(slots / n) + (rank >= 0 && rank < slots % n ? 1 : 0)
}

/**
 * Root slots per stripe, at least one each (the publisher must emit every stripe). A fixed split,
 * not supply-dependent, so membership changes don't reshuffle host slots.
 */
function rootSlotsPerStripe(cfg: PlannerConfig): number[] {
  const S = stripeCount(cfg)
  const hostSlots = Math.max(S, Math.floor(cfg.rootSlots) || 0)
  return [...Array(S).keys()].map((s) => Math.floor(hostSlots / S) + (s < hostSlots % S ? 1 : 0))
}

/** Builds one stripe's tree into the context's parents and depth. */
class StripeBuilder {
  private readonly remaining: Map<string, number>
  private readonly capOf: Map<string, number>
  private readonly load: Map<string, number>
  private readonly nodeDepth: Map<string, number>
  private readonly placedRelays: string[]
  private readonly placed = new Set<string>()
  private readonly relays: PlannerPeer[]
  private readonly relaySet: Set<string>
  private readonly leaves: PlannerPeer[]

  constructor(
    private readonly ctx: PlanContext,
    private readonly s: number,
    hostSlots: number,
  ) {
    const { cfg, current, peers, byId, homes, score } = ctx
    this.remaining = new Map([[cfg.hostId, hostSlots]])
    this.capOf = new Map([[cfg.hostId, hostSlots]])
    this.load = new Map([[cfg.hostId, 0]])
    this.nodeDepth = new Map([[cfg.hostId, 0]])
    this.placedRelays = [cfg.hostId]

    // Existing relays keep their level (shallowest first) so a newcomer doesn't displace a whole
    // subtree; new relays are then placed strongest-first.
    const curDepth = currentDepths(current, s, cfg.hostId, (id) => byId.has(id) && homes[id].includes(s))
    this.relays = peers
      .filter((p) => homes[p.id].includes(s))
      .sort(
        (a, b) =>
          (curDepth.get(a.id) ?? Infinity) - (curDepth.get(b.id) ?? Infinity) ||
          score(b) - score(a) ||
          cmp(a.id, b.id),
      )
    this.relaySet = new Set(this.relays.map((p) => p.id))
    this.leaves = peers.filter((p) => !this.relaySet.has(p.id))
  }

  build(): void {
    const { score } = this.ctx
    this.relays.forEach((p) => this.tryKeep(p))
    ;[...this.relays].sort((a, b) => score(b) - score(a) || cmp(a.id, b.id)).forEach((p) => this.placeAny(p))
    this.leaves.forEach((p) => this.tryKeep(p))
    this.leaves.forEach((p) => this.placeAny(p))
  }

  /** Pass 1: keep a still-valid current attachment. */
  private tryKeep(p: PlannerPeer): void {
    const cur = this.keepable(p, this.bestFree(p))
    if (cur !== null) this.attach(p, cur)
  }

  /** Pass 2: place anywhere (preferring the current parent), overcommitting if necessary. */
  private placeAny(p: PlannerPeer): void {
    if (this.placed.has(p.id)) return
    const best = this.bestFree(p)
    let chosen = this.keepable(p, best) ?? best
    if (chosen === null) {
      chosen = this.overcommitTarget(p)
      if (chosen !== null) this.ctx.overcommitted++
      if (chosen === this.ctx.cfg.hostId) this.ctx.rootOver.push({ peer: p.id, stripe: this.s })
    }
    this.attach(p, chosen)
  }

  /**
   * No free capacity anywhere: stay with the current parent rather than shuffling overcommitted
   * children, else take the relay least loaded relative to its capacity.
   */
  private overcommitTarget(p: PlannerPeer): string | null {
    const cur = this.currentParent(p)
    if (cur !== null && this.nodeDepth.has(cur) && this.canLink(p, cur)) return cur
    let chosen: string | null = null
    let leastRatio = Infinity
    for (const id of this.placedRelays) {
      if (!this.canLink(p, id)) continue
      const ratio = (this.load.get(id)! + 1) / Math.max(this.capOf.get(id)!, 0.5)
      if (ratio < leastRatio) {
        leastRatio = ratio
        chosen = id
      }
    }
    return chosen
  }

  private attach(p: PlannerPeer, chosen: string | null): void {
    const { parents, depth, slots, homes } = this.ctx
    parents[p.id][this.s] = chosen
    this.placed.add(p.id)
    if (chosen === null) return
    this.remaining.set(chosen, (this.remaining.get(chosen) ?? 0) - 1)
    this.load.set(chosen, this.load.get(chosen)! + 1)
    const d = this.nodeDepth.get(chosen)! + 1
    depth[p.id][this.s] = d
    if (this.relaySet.has(p.id)) {
      this.nodeDepth.set(p.id, d)
      const own = slotsIn(slots[p.id], homes[p.id], this.s)
      this.remaining.set(p.id, own)
      this.capOf.set(p.id, own)
      this.load.set(p.id, 0)
      this.placedRelays.push(p.id)
    }
  }

  private currentParent(p: PlannerPeer): string | null {
    return this.ctx.current.parents[p.id]?.[this.s] ?? null
  }

  private bestFree(p: PlannerPeer): string | null {
    let best: string | null = null
    for (const id of this.placedRelays) {
      if ((this.remaining.get(id) ?? 0) <= 0 || !this.canLink(p, id) || this.starved(id)) continue
      if (best === null || this.better(p.id, id, best)) best = id
    }
    return best
  }

  /** Current parent, if it is placed, has room, and is not much worse than the best option. */
  private keepable(p: PlannerPeer, best: string | null): string | null {
    const cfg = this.ctx.cfg
    const cur = this.currentParent(p)
    if (cur === null || !this.nodeDepth.has(cur) || (this.remaining.get(cur) ?? 0) <= 0 || !this.canLink(p, cur)) return null
    if (best === null || best === cur) return cur
    const dCur = this.nodeDepth.get(cur)!
    const dBest = this.nodeDepth.get(best)!
    if (dCur > dBest + cfg.switchGain) return null
    // A parent no deeper that is much closer is worth a move.
    const cCur = this.cost(cur, p.id)
    const cBest = this.cost(best, p.id)
    if (dBest <= dCur && cCur !== null && cBest !== null && cBest + cfg.rttSwitchMs < cCur) return null
    return cur
  }

  /** For `child`: shallower first, then closer (RTT + lateness), then more spare capacity, then id. */
  private better(child: string, a: string, b: string): boolean {
    const da = this.nodeDepth.get(a)!
    const db = this.nodeDepth.get(b)!
    if (da !== db) return da < db
    const ca = this.cost(a, child)
    const cb = this.cost(b, child)
    if (ca !== null && cb !== null && ca !== cb) return ca < cb
    const ra = this.remaining.get(a)!
    const rb = this.remaining.get(b)!
    if (ra !== rb) return ra > rb
    return cmp(a, b) < 0
  }

  /** Distance from a parent to a child: RTT plus the parent's lateness on this stripe. */
  private cost(parentId: string, childId: string): number | null {
    const cfg = this.ctx.cfg
    const rtt = cfg.rtt?.(parentId, childId) ?? null
    if (rtt === null) return null
    return rtt + (cfg.lateness?.(parentId, this.s) ?? 0)
  }

  private canLink(child: PlannerPeer, parentId: string): boolean {
    if (parentId === child.id) return false
    if (child.avoid.includes(parentId)) return false
    const parent = this.ctx.byId.get(parentId)
    return !parent || !parent.avoid.includes(child.id)
  }

  private starved(id: string): boolean {
    return this.ctx.byId.get(id)?.starved?.includes(this.s) ?? false
  }
}

/**
 * Sheds root overcommit where parity allows. The publisher's uplink carries every stripe, so
 * overloading it delays all of them for everyone; a peer that still gets k other stripes just
 * decodes from those. (Newest attachments go first.) A relay keeps its home stripes: its children
 * there depend on it. Only stripes whose parent chain reaches the root count as received.
 */
function shedRootOvercommit(ctx: PlanContext): void {
  const { cfg, peers, parents, depth, homes } = ctx
  const S = stripeCount(cfg)
  const reachesRoot = (id: string, s: number): boolean => {
    let cur: string | null = id
    for (let i = 0; i <= peers.length && cur !== null; i++) {
      if (cur === cfg.hostId) return true
      cur = parents[cur]?.[s] ?? null
    }
    return false
  }
  for (const { peer, stripe } of [...ctx.rootOver].reverse()) {
    if (homes[peer].includes(stripe)) continue
    let live = 0
    for (let s = 0; s < S; s++) if (reachesRoot(peer, s)) live++
    if (live > cfg.k) {
      parents[peer][stripe] = null
      depth[peer][stripe] = 0
      ctx.overcommitted--
    }
  }
}

/** Parent changes from `current` to `parents`, in peer order, then stripe order. */
function diffTopology(
  peers: PlannerPeer[],
  current: Topology,
  parents: Record<string, (string | null)[]>,
  S: number,
): ParentChange[] {
  const changes: ParentChange[] = []
  for (const p of peers) {
    for (let s = 0; s < S; s++) {
      const from = current.parents[p.id]?.[s] ?? null
      const to = parents[p.id][s]
      if (from !== to) changes.push({ peer: p.id, stripe: s, from, to })
    }
  }
  return changes
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
