// Discrete-time simulation of the striped-tree planner under churn.
// Run: npm run sim [-- --peers 200 --seconds 300 --lifetime 240 --repair 2225 --gossip 500]
//      npm run sim -- --sweep parity     (stall vs parity across churn levels)
// `simulate()` is exported for tests/sim.test.ts.
//
// Model (deliberately simple), one publisher planning one channel in a full-mesh lobby:
// - Each peer has a true upload capacity and an access latency. It offers relay slots from a noisy
//   estimate of its upload, re-measured every 10 s. The publisher sees those offers (and new
//   subscribers) only through gossip, `--gossip` ms late, so it plans on slightly stale inputs.
// - The planner and its policy (hysteresis, relay trust, late-parent handling) are the app's own
//   (topology/planner.ts, topology/policy.ts); stripe bitrate and fan-out cap come from
//   session/capacity.ts.
// - The planner breaks ties by RTT (2 × (access(a) + access(b) + 10 ms)).
// - One-way hop latency = access(a) + access(b) + 10ms; serialization = piece bits / per-child rate.
// - A frame is decodable once any k of k+m stripes arrive -> latency = k-th fastest stripe path.
// - When a peer leaves, its descendants lose that stripe for REPAIR_MS (detect + replan + relink).
//   A viewer stalls while it is missing more than m stripes.
// - Overloaded parents (children * stripe rate > true capacity) degrade their subtree.

import { pathToFileURL } from 'node:url'
import { HEADROOM, MAX_FANOUT, rebalanceWeights, splitBudget, stripeKbpsFor } from '../src/session/capacity'
import type { PlannerConfig, PlannerPeer, Topology } from '../src/topology/model'
import { emptyTopology, subtree } from '../src/topology/model'
import { plan } from '../src/topology/planner'
import { defaultPlannerConfig, LATE_PARENT_AVOID_MS, LateParentTracker, REATTACH_BATCH_MS, type LatenessSample } from '../src/topology/policy'
import { tuning } from '../src/tuning'

/** Subscribers check their stripes for silence every 250 ms (session/subscription.ts): half on average. */
const HEALTH_CHECK_LAG_MS = 125
/** Replan, set-parent/add-child, and the new parent's GOP replay over an existing mesh link (~1 RTT). */
const RELINK_MS = 200
/**
 * Time from a parent vanishing to its subtree receiving again: stripe-silence detection, the
 * health-check lag, reattach batching, then relinking. Reattaching reuses an existing mesh link
 * (no ICE/DTLS setup). The e2e failover tests measure 1–2.5 s.
 */
export const REPAIR_MS = tuning.stripeSilenceMs + HEALTH_CHECK_LAG_MS + REATTACH_BATCH_MS + RELINK_MS

const REESTIMATE_MS = 10_000
const BITRATE_KBPS = 2500
const FPS = 30
const TICK_MS = 100
const REPLAN_EVERY_MS = 2000
const ENCODE_MS = 30
const BUFFER_MS = 60
/** Extra forwarding delay of a "late" relay (alive, but slow to pass data on). */
const LATE_EXTRA_MS = 250

const HOST = 'host'

type Rng = () => number

function makeRng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface SimPeer {
  id: string
  trueKbps: number
  accessMs: number
  joinedAt: number
  leaveAt: number
}

function samplePeer(rnd: Rng, i: number, now: number, lifetimeS: number): SimPeer {
  const r = rnd()
  // Rough residential mix: many weak uplinks, some strong.
  const trueKbps = r < 0.25 ? 500 : r < 0.6 ? 2000 : r < 0.85 ? 8000 : 30000
  return {
    id: `p${i}`,
    trueKbps,
    accessMs: 5 + rnd() * 45,
    joinedAt: now,
    leaveAt: now - Math.log(1 - rnd()) * lifetimeS * 1000,
  }
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]
}

/** Deterministic per-peer coin, independent of the main random stream. */
function coin(id: string, salt: number): number {
  let h = salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761) >>> 0
  return (h % 10_000) / 10_000
}

export interface SimOptions {
  k: number
  m: number
  peers?: number
  seconds?: number
  /** Mean viewer lifetime (s). */
  lifetimeS?: number
  repairMs?: number
  gossipMs?: number
  hostUploadKbps?: number
  maxFanout?: number
  /** Whether the stream carries audio (adds to every stripe). */
  audio?: boolean
  seed?: number
  /** Share of peers that forward LATE_EXTRA_MS late. */
  lateFrac?: number
  /** Whether the planner reacts to measured lateness (penalty + moving children away). */
  handleLate?: boolean
}

export interface SimMetrics {
  k: number
  m: number
  p50: number
  p95: number
  maxDepth: number
  stallPct: number
  /** Distinct stalls per viewer-hour, and their mean length. */
  stallsPerHour: number
  meanStallMs: number
  degradedPct: number
  changesPerMin: number
}

const DEFAULTS = {
  peers: 200,
  seconds: 300,
  lifetimeS: 240,
  repairMs: REPAIR_MS,
  gossipMs: 500,
  hostUploadKbps: 10_000,
  maxFanout: MAX_FANOUT,
  audio: true,
  seed: 42,
  lateFrac: 0,
  handleLate: true,
}

type Resolved = SimOptions & typeof DEFAULTS

/** One publisher, one channel, a churning audience. */
class Simulation {
  private readonly rnd: Rng
  private readonly S: number
  private readonly stripeKbps: number
  private readonly cfg: PlannerConfig
  private readonly access = new Map<string, number>([[HOST, 10]])
  private readonly trueCap: Map<string, number>
  /** Offered slots over time per peer: [time it was gossiped, slots], newest last. */
  private readonly offerHistory = new Map<string, [number, number][]>()
  private readonly live = new Map<string, SimPeer>()
  private readonly late = new LateParentTracker()
  private readonly avoidUntil = new Map<string, Map<string, number>>()
  private nextId = 0
  private topo: Topology = emptyTopology()
  private lastPlan = -Infinity
  /** outage[peer][stripe] = time until which the stripe is missing. */
  private readonly outage = new Map<string, number[]>()

  // Metrics.
  private changes = 0
  private readonly latencies: number[] = []
  private maxDepth = 0
  private stallTicks = 0
  private stallEvents = 0
  private readonly stalled = new Set<string>()
  private degradedTicks = 0
  private viewerTicks = 0

  constructor(private readonly o: Resolved) {
    this.rnd = makeRng(o.seed)
    this.S = o.k + o.m
    this.stripeKbps = stripeKbpsFor(BITRATE_KBPS, o.k, o.audio)
    this.trueCap = new Map([[HOST, o.hostUploadKbps]])
    this.cfg = defaultPlannerConfig({
      hostId: HOST,
      k: o.k,
      m: o.m,
      rootSlots: Math.floor((o.hostUploadKbps * HEADROOM) / this.stripeKbps),
      maxFanout: o.maxFanout,
      rtt: (a, b) => 2 * ((this.access.get(a) ?? 10) + (this.access.get(b) ?? 10) + 10),
      lateness: o.handleLate ? (parent, stripe) => this.late.get(parent, stripe) : undefined,
    })
    for (let i = 0; i < o.peers; i++) this.add(-60_000 * this.rnd()) // staggered existing audience
  }

  run(): SimMetrics {
    this.replan(0)
    for (let now = 0; now < this.o.seconds * 1000; now += TICK_MS) {
      this.churn(now)
      this.observe(now)
    }
    return this.metrics()
  }

  private lateExtra(id: string): number {
    return id !== HOST && coin(id, 7) < this.o.lateFrac ? LATE_EXTRA_MS : 0
  }

  private offerFor(id: string, now: number): number {
    let slots = 0
    for (const [at, n] of this.offerHistory.get(id) ?? []) if (at + this.o.gossipMs <= now) slots = n
    return slots
  }

  private reestimate(id: string, at: number): void {
    const est = this.trueCap.get(id)! * (0.8 + this.rnd() * 0.3)
    const h = this.offerHistory.get(id) ?? []
    h.push([at, Math.floor((est * HEADROOM) / this.stripeKbps)])
    if (h.length > 4) h.shift()
    this.offerHistory.set(id, h)
  }

  private add(now: number): void {
    const p = samplePeer(this.rnd, this.nextId++, now, this.o.lifetimeS)
    this.live.set(p.id, p)
    this.access.set(p.id, p.accessMs)
    this.trueCap.set(p.id, p.trueKbps)
    this.reestimate(p.id, now + 1500) // the probe takes ~1.5 s
  }

  /** Departures, arrivals, re-measurements and replanning for one tick. */
  private churn(now: number): void {
    // Departures: descendants lose the stripe until repaired.
    let departed = false
    for (const p of [...this.live.values()]) {
      if (p.leaveAt > now) continue
      for (let s = 0; s < this.S; s++) {
        for (const d of subtree(this.topo, p.id, s)) {
          const o = this.outage.get(d) ?? new Array(this.S).fill(-Infinity)
          o[s] = Math.max(o[s], now + this.o.repairMs)
          this.outage.set(d, o)
        }
      }
      this.live.delete(p.id)
      this.outage.delete(p.id)
      this.offerHistory.delete(p.id)
      this.stalled.delete(p.id)
      departed = true
    }
    // Arrivals keep the audience roughly stable.
    while (this.live.size < this.o.peers) this.add(now)
    if (now % REESTIMATE_MS === 0) for (const p of this.live.values()) if (now - p.joinedAt > 1500) this.reestimate(p.id, now)
    if (departed || now - this.lastPlan >= REPLAN_EVERY_MS) this.replan(now)
  }

  private replan(now: number): void {
    if (this.o.handleLate) this.updateLateness(now)
    // Departures are seen at once (the publisher's own mesh links); joins and offers through gossip.
    const peers: PlannerPeer[] = [...this.live.values()]
      .filter((p) => now - p.joinedAt >= this.o.gossipMs)
      .map((p) => ({
        id: p.id,
        slots: this.offerFor(p.id, now),
        joinedAt: p.joinedAt,
        failures: 0,
        avoid: [...(this.avoidUntil.get(p.id) ?? new Map<string, number>())].filter(([, t]) => t > now).map(([a]) => a),
      }))
    const r = plan(peers, this.topo, this.cfg, now)
    this.changes += r.changes.length
    this.topo = r.topology
    this.lastPlan = now
  }

  /**
   * The app's late-parent policy, fed with what children would report: each child attached in the
   * current plan sees its parent's extra forwarding delay.
   */
  private updateLateness(now: number): void {
    const samples: LatenessSample[] = []
    for (const [child, ps] of Object.entries(this.topo.parents)) {
      if (!this.live.has(child)) continue
      ps.forEach((parent, stripe) => {
        if (parent && parent !== HOST && this.live.has(parent)) samples.push({ parent, stripe, lateMs: this.lateExtra(parent), parentLateMs: 0 })
      })
    }
    for (const { parent, stripe } of this.late.update(samples, now)) {
      for (const [child, ps] of Object.entries(this.topo.parents)) {
        if (ps[stripe] !== parent) continue
        const m = this.avoidUntil.get(child) ?? new Map<string, number>()
        m.set(parent, now + LATE_PARENT_AVOID_MS)
        this.avoidUntil.set(child, m)
      }
    }
  }

  /** Stall, quality and latency of every settled viewer for one tick. */
  private observe(now: number): void {
    const { k, m } = this.o
    // Load per parent per stripe.
    const load = new Map<string, number>()
    for (const ps of Object.values(this.topo.parents)) {
      ps.forEach((par) => par && load.set(par, (load.get(par) ?? 0) + 1))
    }
    const pieceBits = (this.stripeKbps * 1000) / FPS
    const sampleLatency = now % 1000 === 0
    for (const p of this.live.values()) {
      if (now - p.joinedAt < 3000 + this.o.gossipMs) continue // still joining
      this.viewerTicks++
      const o = this.outage.get(p.id)
      const missing = o ? o.filter((t) => t > now).length : 0
      if (missing > m) {
        this.stallTicks++
        if (!this.stalled.has(p.id)) {
          this.stalled.add(p.id)
          this.stallEvents++
        }
      } else {
        this.stalled.delete(p.id)
      }

      const stripeLat: number[] = []
      const stripeQuality: number[] = []
      for (let s = 0; s < this.S; s++) {
        let lat = 0
        let quality = 1
        let cur = p.id
        let depth = 0
        while (cur !== HOST) {
          const par = this.topo.parents[cur]?.[s]
          if (!par) {
            lat = Infinity
            break
          }
          const children = load.get(par) ?? 1
          const cap = this.trueCap.get(par)!
          const perChild = Math.min(cap / children, cap)
          lat += this.access.get(par)! + this.access.get(cur)! + 10 + pieceBits / perChild + this.lateExtra(par)
          quality = Math.min(quality, cap / (children * this.stripeKbps))
          cur = par
          depth++
        }
        this.maxDepth = Math.max(this.maxDepth, depth)
        stripeLat.push(lat)
        stripeQuality.push(Math.min(1, quality))
      }
      stripeLat.sort((a, b) => a - b)
      stripeQuality.sort((a, b) => b - a)
      if (stripeQuality[k - 1] < 0.95) this.degradedTicks++
      if (sampleLatency && Number.isFinite(stripeLat[k - 1])) this.latencies.push(ENCODE_MS + BUFFER_MS + stripeLat[k - 1])
    }
  }

  private metrics(): SimMetrics {
    const { k, m, seconds } = this.o
    return {
      k,
      m,
      p50: quantile(this.latencies, 0.5),
      p95: quantile(this.latencies, 0.95),
      maxDepth: this.maxDepth,
      stallPct: (100 * this.stallTicks) / this.viewerTicks,
      stallsPerHour: this.stallEvents / ((this.viewerTicks * TICK_MS) / 3_600_000),
      meanStallMs: this.stallEvents ? (this.stallTicks * TICK_MS) / this.stallEvents : 0,
      degradedPct: (100 * this.degradedTicks) / this.viewerTicks,
      changesPerMin: this.changes / (seconds / 60),
    }
  }
}

/** Runs one scenario and returns its metrics. Deterministic for a given seed. */
export function simulate(opts: SimOptions): SimMetrics {
  return new Simulation({ ...DEFAULTS, ...stripUndefined(opts) }).run()
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/**
 * Two publishers competing for the same audience's upload: every peer watches both channels and
 * splits its budget between them (session/capacity.ts). The budget is split by stripe bitrate,
 * i.e. into about as many slots for each channel, but B needs more of them (5 stripes against 2),
 * so B runs short while A has slots to spare.
 * With rebalancing, peers shift weight towards the channel that reports a deficit every 10 s.
 */
export function simulateCompeting(
  rebalance: boolean,
  o: { peers?: number; seconds?: number; hostUploadKbps?: number; maxFanout?: number; seed?: number } = {},
): { deficit: [number, number]; degraded: [number, number] } {
  const { peers: nPeers, seconds, hostUploadKbps, maxFanout, seed } = { ...DEFAULTS, ...stripUndefined(o) }
  const rnd = makeRng(seed)
  const channels = [
    { host: 'hostA', kbps: 1500, k: 2, m: 0 },
    { host: 'hostB', kbps: 3000, k: 4, m: 1 },
  ].map((c) => ({ ...c, stripeKbps: stripeKbpsFor(c.kbps, c.k, false), topo: emptyTopology() as Topology, deficit: 0 }))
  const peers = Array.from({ length: nPeers }, (_, i) => samplePeer(rnd, i, -10_000, 1e9))
  const weights = new Map(peers.map((p) => [p.id, { 0: 1, 1: 1 } as Record<string, number>]))
  const estimate = new Map(peers.map((p) => [p.id, p.trueKbps * (0.8 + rnd() * 0.3)]))
  const sums = { deficit: [0, 0], degraded: [0, 0], samples: 0 }
  for (let now = 0; now < seconds * 1000; now += REPLAN_EVERY_MS) {
    if (rebalance && now % 10_000 === 0) {
      for (const p of peers) weights.set(p.id, rebalanceWeights(weights.get(p.id)!, { 0: channels[0].deficit, 1: channels[1].deficit }))
    }
    // Each peer's offer per channel from its weighted budget split.
    const offers = new Map(
      peers.map((p) => {
        const w = weights.get(p.id)!
        const split = splitBudget(estimate.get(p.id)!, [], channels.map((c, i) => ({ id: i, stripeKbps: c.stripeKbps, weight: w[i] })))
        return [p.id, split.offers]
      }),
    )
    channels.forEach((c, i) => {
      const cfg = defaultPlannerConfig({
        hostId: c.host,
        k: c.k,
        m: c.m,
        rootSlots: Math.floor((hostUploadKbps * HEADROOM) / c.stripeKbps),
        maxFanout,
      })
      const r = plan(
        peers.map((p) => ({ id: p.id, slots: offers.get(p.id)![i] ?? 0, joinedAt: p.joinedAt, failures: 0, avoid: [] })),
        c.topo,
        cfg,
        now,
      )
      c.topo = r.topology
      c.deficit = r.overcommitted
      if (now >= 30_000) {
        sums.deficit[i] += r.overcommitted
        // Degraded: a parent's children need more than its true upload share for this channel.
        let degraded = 0
        const load = new Map<string, number>()
        for (const ps of Object.values(r.topology.parents)) ps.forEach((par) => par && load.set(par, (load.get(par) ?? 0) + 1))
        for (const p of peers) {
          const over = r.topology.parents[p.id].filter((par) => {
            if (!par || par === c.host) return false
            const share = peers.find((x) => x.id === par)!.trueKbps * (weights.get(par)![i] / (weights.get(par)![0] + weights.get(par)![1]))
            return (load.get(par) ?? 0) * c.stripeKbps > share
          }).length
          if (over > c.m) degraded++
        }
        sums.degraded[i] += degraded / peers.length
      }
    })
    if (now >= 30_000) sums.samples++
  }
  return {
    deficit: [sums.deficit[0] / sums.samples, sums.deficit[1] / sums.samples],
    degraded: [(100 * sums.degraded[0]) / sums.samples, (100 * sums.degraded[1]) / sums.samples],
  }
}

// --- CLI ---------------------------------------------------------------------------------------

function fmtRow(r: SimMetrics): string {
  return `${String(r.k).padEnd(2)} ${String(r.m).padEnd(1)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${String(r.maxDepth).padStart(9)} | ${r.stallPct.toFixed(3).padStart(7)} | ${r.stallsPerHour.toFixed(2).padStart(9)} | ${r.degradedPct.toFixed(2).padStart(10)} | ${r.changesPerMin.toFixed(0).padStart(18)}`
}

function main(argv: string[]): void {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1])
  const num = (name: string) => (args.has(name) ? Number(args.get(name)) : undefined)
  const base = {
    peers: num('peers'),
    seconds: num('seconds'),
    lifetimeS: num('lifetime'),
    repairMs: num('repair'),
    gossipMs: num('gossip'),
    hostUploadKbps: num('host'),
    maxFanout: num('fanout'),
    audio: args.has('audio') ? args.get('audio') !== '0' : undefined,
    seed: num('seed'),
  }
  const o = { ...DEFAULTS, ...stripUndefined(base) }
  const sweep = args.get('sweep')

  if (sweep === 'late') {
    // Relays that are alive but consistently late: with and without the planner reacting.
    console.log(`peers=${o.peers} seconds=${o.seconds} late relays forward ${LATE_EXTRA_MS} ms late\n`)
    console.log('late share | handled | p50 ms | p95 ms | stall %')
    console.log('-----------+---------+--------+--------+--------')
    for (const lateFrac of [0, 0.1, 0.25]) {
      for (const handleLate of [false, true]) {
        if (lateFrac === 0 && !handleLate) continue
        const r = simulate({ ...base, k: 4, m: 1, lateFrac, handleLate })
        console.log(`${`${lateFrac * 100}%`.padStart(10)} | ${(handleLate ? 'yes' : 'no').padStart(7)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${r.stallPct.toFixed(3).padStart(7)}`)
      }
    }
  } else if (sweep === 'competing') {
    console.log(`peers=${o.peers} seconds=${o.seconds}: two publishers (A 1.5 Mbps in 2+0 stripes, B 3 Mbps in 4+1), everyone watches both\n`)
    console.log('rebalancing | overcommitted A | overcommitted B | degraded % A | degraded % B')
    console.log('------------+-----------------+-----------------+--------------+-------------')
    for (const rebalance of [false, true]) {
      const r = simulateCompeting(rebalance, base)
      console.log(`${(rebalance ? 'yes' : 'no').padStart(11)} | ${r.deficit[0].toFixed(1).padStart(15)} | ${r.deficit[1].toFixed(1).padStart(15)} | ${r.degraded[0].toFixed(2).padStart(12)} | ${r.degraded[1].toFixed(2).padStart(12)}`)
    }
  } else if (sweep === 'parity') {
    // How much does parity buy? Stall time (% of viewing time) for each (k, m) across churn levels.
    const lifetimes = [60, 240, 900]
    const configs: [number, number][] = [
      [1, 0],
      [2, 0],
      [2, 1],
      [2, 2],
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
      [8, 0],
      [8, 2],
      [8, 4],
    ]
    console.log(`peers=${o.peers} seconds=${o.seconds} repair=${o.repairMs}ms gossip=${o.gossipMs}ms bitrate=${BITRATE_KBPS}kbps hostUpload=${o.hostUploadKbps}kbps audio=${o.audio}`)
    console.log('stall % of viewing time (stalls per viewer-hour) by mean viewer lifetime\n')
    console.log(`k  m | overhead | ${lifetimes.map((l) => `life ${l}s`.padStart(16)).join(' | ')} | degraded % (240s)`)
    console.log(`-----+----------+-${lifetimes.map(() => '-'.repeat(16)).join('-+-')}-+------------------`)
    for (const [k, m] of configs) {
      const cells: string[] = []
      let degraded = 0
      for (const l of lifetimes) {
        const r = simulate({ ...base, k, m, lifetimeS: l })
        cells.push(`${r.stallPct.toFixed(3)} (${r.stallsPerHour.toFixed(1)})`.padStart(16))
        if (l === 240) degraded = r.degradedPct
      }
      console.log(`${String(k).padEnd(2)} ${m} | ${`${Math.round((100 * m) / k)}%`.padStart(8)} | ${cells.join(' | ')} | ${degraded.toFixed(2).padStart(17)}`)
    }
  } else {
    // --only 4:1,8:4 restricts the table to specific (k, m) pairs.
    const only = args.get('only')?.split(',').map((x) => x.split(':').map(Number) as [number, number])
    const configs: [number, number][] = only ?? [
      [1, 0],
      [2, 0],
      [4, 0],
      [4, 1],
      [4, 2],
      [8, 2],
    ]
    console.log(
      `peers=${o.peers} seconds=${o.seconds} meanLifetime=${o.lifetimeS}s repair=${o.repairMs}ms gossip=${o.gossipMs}ms fanout=${o.maxFanout} bitrate=${BITRATE_KBPS}kbps audio=${o.audio} hostUpload=${o.hostUploadKbps}kbps\n`,
    )
    console.log('k  m | p50 ms | p95 ms | max depth | stall % | stalls/hr | degraded % | parent changes/min')
    console.log('-----+--------+--------+-----------+---------+-----------+------------+-------------------')
    for (const [k, m] of configs) console.log(fmtRow(simulate({ ...base, k, m })))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
