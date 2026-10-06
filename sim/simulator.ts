// Discrete-time simulation of the striped-tree planner under churn.
// Run: npm run sim [-- --peers 200 --seconds 300 --lifetime 240 --repair 2500 --gossip 500]
//      npm run sim -- --sweep parity     (stall vs parity across churn levels)
//
// Model (deliberately simple), one publisher planning one channel in a full-mesh lobby:
// - Each peer has a true upload capacity and an access latency. It offers relay slots from a noisy
//   estimate of its upload, re-measured every 10 s. The publisher sees those offers (and new
//   subscribers) only through gossip, `--gossip` ms late, so it plans on slightly stale inputs.
// - The planner breaks ties by RTT (2 × (access(a) + access(b) + 10 ms)).
// - One-way hop latency = access(a) + access(b) + 10ms; serialization = piece bits / per-child rate.
// - A frame is decodable once any k of k+m stripes arrive -> latency = k-th fastest stripe path.
// - When a peer leaves, its descendants lose that stripe for REPAIR_MS (detect + replan + link setup).
//   A viewer stalls while it is missing more than m stripes.
// - Overloaded parents (children * stripe rate > true capacity) degrade their subtree.

import { HEADROOM, rebalanceWeights, splitBudget } from '../src/session/capacity'
import type { PlannerConfig, PlannerPeer, Topology } from '../src/topology/model'
import { emptyTopology } from '../src/topology/model'
import { plan } from '../src/topology/planner'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

const PEERS = Number(args.get('peers') ?? 200)
const SECONDS = Number(args.get('seconds') ?? 300)
const MEAN_LIFETIME_S = Number(args.get('lifetime') ?? 240)
// Time from a parent vanishing to its subtree receiving again: 2 s silence detection + 0.4 s
// batching + replan + keyframe replay. Reattaching reuses an existing mesh link (no ICE/DTLS setup),
// so this is about 1 s less than with on-demand tree links.
const REPAIR_MS = Number(args.get('repair') ?? 2500)
const GOSSIP_DELAY_MS = Number(args.get('gossip') ?? 500)
const REESTIMATE_MS = 10_000
const BITRATE_KBPS = 2500
const FPS = 30
const HOST_UPLOAD_KBPS = Number(args.get('host') ?? 10000)
const MAX_FANOUT = Number(args.get('fanout') ?? 16)
const TICK_MS = 100
const REPLAN_EVERY_MS = 2000
const ENCODE_MS = 30
const BUFFER_MS = 60

const HOST = 'host'

let seed = Number(args.get('seed') ?? 42)
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}

interface SimPeer {
  id: string
  trueKbps: number
  accessMs: number
  joinedAt: number
  leaveAt: number
}

function samplePeer(i: number, now: number, lifetimeS: number): SimPeer {
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

interface Result {
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

/** Deterministic per-peer coin, independent of the main random stream. */
function coin(id: string, salt: number): number {
  let h = salt
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761) >>> 0
  return (h % 10_000) / 10_000
}

/** Extra forwarding delay of a "late" relay (alive, but slow to pass data on). */
const LATE_EXTRA_MS = 250
/** As in the app: a parent late by more than 150 ms for 10 s loses its children for 30 s. */
const LATE_LIMIT_MS = 150
const LATE_FOR_MS = 10_000
const LATE_AVOID_MS = 30_000

interface RunOptions {
  /** Share of peers that forward LATE_EXTRA_MS late. */
  lateFrac?: number
  /** Whether the planner reacts to measured lateness (penalty + moving children away). */
  handleLate?: boolean
}

function run(k: number, m: number, lifetimeS = MEAN_LIFETIME_S, repairMs = REPAIR_MS, ro: RunOptions = {}): Result {
  seed = Number(args.get('seed') ?? 42)
  const lateFrac = ro.lateFrac ?? 0
  const handleLate = ro.handleLate ?? true
  const lateExtra = (id: string) => (id !== HOST && coin(id, 7) < lateFrac ? LATE_EXTRA_MS : 0)
  /** When each relay started relaying (lateness is only measured once it has children). */
  const relaySince = new Map<string, number>()
  const avoidUntil = new Map<string, Map<string, number>>()
  let planNow = 0
  const S = k + m
  const stripeKbps = (BITRATE_KBPS / k) * 1.03
  const access = new Map<string, number>([[HOST, 10]])
  const cfg: PlannerConfig = {
    hostId: HOST,
    k,
    m,
    rootSlots: Math.floor((HOST_UPLOAD_KBPS * HEADROOM) / stripeKbps),
    maxFanout: MAX_FANOUT,
    minUptimeMsForRelay: 4000,
    switchGain: 1,
    rttSwitchMs: 40,
    rtt: (a, b) => 2 * ((access.get(a) ?? 10) + (access.get(b) ?? 10) + 10),
    lateness: handleLate ? (parent) => (planNow - (relaySince.get(parent) ?? Infinity) >= 2000 ? lateExtra(parent) : 0) : undefined,
  }
  const trueCap = new Map<string, number>([[HOST, HOST_UPLOAD_KBPS]])
  /** Offered slots over time per peer: [time it was gossiped, slots], newest last. */
  const offerHistory = new Map<string, [number, number][]>()
  const offerFor = (id: string, now: number): number => {
    let slots = 0
    for (const [at, n] of offerHistory.get(id) ?? []) if (at + GOSSIP_DELAY_MS <= now) slots = n
    return slots
  }
  const reestimate = (id: string, at: number) => {
    const est = trueCap.get(id)! * (0.8 + rnd() * 0.3)
    const h = offerHistory.get(id) ?? []
    h.push([at, Math.floor((est * HEADROOM) / stripeKbps)])
    if (h.length > 4) h.shift()
    offerHistory.set(id, h)
  }

  let nextId = 0
  const live = new Map<string, SimPeer>()
  const add = (now: number) => {
    const p = samplePeer(nextId++, now, lifetimeS)
    live.set(p.id, p)
    access.set(p.id, p.accessMs)
    trueCap.set(p.id, p.trueKbps)
    reestimate(p.id, now + 1500) // the probe takes ~1.5 s
  }
  for (let i = 0; i < PEERS; i++) add(-60_000 * rnd()) // staggered existing audience

  let topo: Topology = emptyTopology()
  let lastPlan = -Infinity
  let changes = 0
  // outage[peer][stripe] = time until which the stripe is missing
  const outage = new Map<string, number[]>()
  const latencies: number[] = []
  let maxDepth = 0
  let stallTicks = 0
  let stallEvents = 0
  const stalled = new Set<string>()
  let degradedTicks = 0
  let viewerTicks = 0

  const replan = (now: number) => {
    planNow = now
    for (const [id, h] of Object.entries(topo.home)) {
      if (h === null) relaySince.delete(id)
      else if (!relaySince.has(id)) relaySince.set(id, now)
    }
    if (handleLate) {
      // A relay late for LATE_FOR_MS loses its children for a while.
      for (const [id, since] of relaySince) {
        if (lateExtra(id) <= LATE_LIMIT_MS || now - since < LATE_FOR_MS) continue
        for (const [child, ps] of Object.entries(topo.parents)) {
          if (!ps.includes(id)) continue
          const m = avoidUntil.get(child) ?? new Map<string, number>()
          m.set(id, now + LATE_AVOID_MS)
          avoidUntil.set(child, m)
        }
        relaySince.set(id, now)
      }
    }
    // Departures are seen at once (the publisher's own mesh links); joins and offers through gossip.
    const peers: PlannerPeer[] = [...live.values()]
      .filter((p) => now - p.joinedAt >= GOSSIP_DELAY_MS)
      .map((p) => ({
        id: p.id,
        slots: offerFor(p.id, now),
        joinedAt: p.joinedAt,
        failures: 0,
        avoid: [...(avoidUntil.get(p.id) ?? new Map<string, number>())].filter(([, t]) => t > now).map(([a]) => a),
      }))
    const r = plan(peers, topo, cfg, now)
    changes += r.changes.length
    topo = r.topology
    lastPlan = now
  }

  const descendants = (root: string, stripe: number): string[] => {
    const kids = new Map<string, string[]>()
    for (const [id, ps] of Object.entries(topo.parents)) {
      const par = ps[stripe]
      if (par) kids.set(par, [...(kids.get(par) ?? []), id])
    }
    const out: string[] = []
    const stack = [...(kids.get(root) ?? [])]
    while (stack.length) {
      const n = stack.pop()!
      out.push(n)
      stack.push(...(kids.get(n) ?? []))
    }
    return out
  }

  replan(0)
  for (let now = 0; now < SECONDS * 1000; now += TICK_MS) {
    // Departures: descendants lose the stripe until repaired.
    let departed = false
    for (const p of [...live.values()]) {
      if (p.leaveAt > now) continue
      for (let s = 0; s < S; s++) {
        for (const d of descendants(p.id, s)) {
          const o = outage.get(d) ?? new Array(S).fill(-Infinity)
          o[s] = Math.max(o[s], now + repairMs)
          outage.set(d, o)
        }
      }
      live.delete(p.id)
      outage.delete(p.id)
      offerHistory.delete(p.id)
      stalled.delete(p.id)
      departed = true
    }
    // Arrivals keep the audience roughly stable.
    while (live.size < PEERS) add(now)
    if (now % REESTIMATE_MS === 0) for (const p of live.values()) if (now - p.joinedAt > 1500) reestimate(p.id, now)
    if (departed || now - lastPlan >= REPLAN_EVERY_MS) replan(now)

    // Load per parent per stripe.
    const load = new Map<string, number>()
    for (const ps of Object.values(topo.parents)) {
      ps.forEach((par) => par && load.set(par, (load.get(par) ?? 0) + 1))
    }

    const sampleLatency = now % 1000 === 0
    for (const p of live.values()) {
      if (now - p.joinedAt < 3000 + GOSSIP_DELAY_MS) continue // still joining
      viewerTicks++
      const o = outage.get(p.id)
      const missing = o ? o.filter((t) => t > now).length : 0
      if (missing > m) {
        stallTicks++
        if (!stalled.has(p.id)) {
          stalled.add(p.id)
          stallEvents++
        }
      } else {
        stalled.delete(p.id)
      }

      const stripeLat: number[] = []
      const stripeQuality: number[] = []
      for (let s = 0; s < S; s++) {
        let lat = 0
        let quality = 1
        let cur = p.id
        let depth = 0
        while (cur !== HOST) {
          const par = topo.parents[cur]?.[s]
          if (!par) {
            lat = Infinity
            break
          }
          const children = load.get(par) ?? 1
          const perChild = Math.min(trueCap.get(par)! / children, trueCap.get(par)!)
          const pieceBits = ((BITRATE_KBPS * 1000) / FPS / k) * 1.03
          lat += access.get(par)! + access.get(cur)! + 10 + pieceBits / perChild + lateExtra(par)
          quality = Math.min(quality, (trueCap.get(par)! / (children * stripeKbps)))
          cur = par
          depth++
        }
        maxDepth = Math.max(maxDepth, depth)
        stripeLat.push(lat)
        stripeQuality.push(Math.min(1, quality))
      }
      stripeLat.sort((a, b) => a - b)
      stripeQuality.sort((a, b) => b - a)
      if (stripeQuality[k - 1] < 0.95) degradedTicks++
      if (sampleLatency && Number.isFinite(stripeLat[k - 1])) latencies.push(ENCODE_MS + BUFFER_MS + stripeLat[k - 1])
    }
  }

  return {
    k,
    m,
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    maxDepth,
    stallPct: (100 * stallTicks) / viewerTicks,
    stallsPerHour: stallEvents / ((viewerTicks * TICK_MS) / 3_600_000),
    meanStallMs: stallEvents ? (stallTicks * TICK_MS) / stallEvents : 0,
    degradedPct: (100 * degradedTicks) / viewerTicks,
    changesPerMin: changes / (SECONDS / 60),
  }
}

function fmtRow(r: Result): string {
  return `${String(r.k).padEnd(2)} ${String(r.m).padEnd(1)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${String(r.maxDepth).padStart(9)} | ${r.stallPct.toFixed(3).padStart(7)} | ${r.stallsPerHour.toFixed(2).padStart(9)} | ${r.degradedPct.toFixed(2).padStart(10)} | ${r.changesPerMin.toFixed(0).padStart(18)}`
}

/**
 * Two publishers competing for the same audience's upload: every peer watches both channels and
 * splits its budget between them (session/capacity.ts). The budget is split by stripe bitrate,
 * i.e. into about as many slots for each channel, but B needs more of them (5 stripes against 2),
 * so B runs short while A has slots to spare.
 * With rebalancing, peers shift weight towards the channel that reports a deficit every 10 s.
 */
function runCompeting(rebalance: boolean): { deficit: [number, number]; degraded: [number, number] } {
  seed = Number(args.get('seed') ?? 42)
  const channels = [
    { host: 'hostA', kbps: 1500, k: 2, m: 0 },
    { host: 'hostB', kbps: 3000, k: 4, m: 1 },
  ].map((c) => ({ ...c, stripeKbps: (c.kbps / c.k) * 1.03, topo: emptyTopology() as Topology, deficit: 0 }))
  const peers = Array.from({ length: PEERS }, (_, i) => samplePeer(i, -10_000, 1e9))
  const weights = new Map(peers.map((p) => [p.id, { 0: 1, 1: 1 } as Record<string, number>]))
  const estimate = new Map(peers.map((p) => [p.id, p.trueKbps * (0.8 + rnd() * 0.3)]))
  const sums = { deficit: [0, 0], degraded: [0, 0], samples: 0 }
  for (let now = 0; now < SECONDS * 1000; now += REPLAN_EVERY_MS) {
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
      const cfg: PlannerConfig = {
        hostId: c.host,
        k: c.k,
        m: c.m,
        rootSlots: Math.floor((HOST_UPLOAD_KBPS * HEADROOM) / c.stripeKbps),
        maxFanout: MAX_FANOUT,
        minUptimeMsForRelay: 4000,
        switchGain: 1,
      }
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
            const share = (peers.find((x) => x.id === par)!.trueKbps * (weights.get(par)![i] / (weights.get(par)![0] + weights.get(par)![1])))
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

if (args.get('sweep') === 'late') {
  // Relays that are alive but consistently late: with and without the planner reacting.
  console.log(`peers=${PEERS} seconds=${SECONDS} late relays forward ${LATE_EXTRA_MS} ms late\n`)
  console.log('late share | handled | p50 ms | p95 ms | stall %')
  console.log('-----------+---------+--------+--------+--------')
  for (const lateFrac of [0, 0.1, 0.25]) {
    for (const handleLate of [false, true]) {
      if (lateFrac === 0 && !handleLate) continue
      const r = run(4, 1, MEAN_LIFETIME_S, REPAIR_MS, { lateFrac, handleLate })
      console.log(`${`${lateFrac * 100}%`.padStart(10)} | ${(handleLate ? 'yes' : 'no').padStart(7)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${r.stallPct.toFixed(3).padStart(7)}`)
    }
  }
} else if (args.get('sweep') === 'competing') {
  console.log(`peers=${PEERS} seconds=${SECONDS}: two publishers (A 1.5 Mbps in 2+0 stripes, B 3 Mbps in 4+1), everyone watches both\n`)
  console.log('rebalancing | overcommitted A | overcommitted B | degraded % A | degraded % B')
  console.log('------------+-----------------+-----------------+--------------+-------------')
  for (const rebalance of [false, true]) {
    const r = runCompeting(rebalance)
    console.log(`${(rebalance ? 'yes' : 'no').padStart(11)} | ${r.deficit[0].toFixed(1).padStart(15)} | ${r.deficit[1].toFixed(1).padStart(15)} | ${r.degraded[0].toFixed(2).padStart(12)} | ${r.degraded[1].toFixed(2).padStart(12)}`)
  }
} else if (args.get('sweep') === 'parity') {
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
  console.log(`peers=${PEERS} seconds=${SECONDS} repair=${REPAIR_MS}ms gossip=${GOSSIP_DELAY_MS}ms bitrate=${BITRATE_KBPS}kbps hostUpload=${HOST_UPLOAD_KBPS}kbps`)
  console.log('stall % of viewing time (stalls per viewer-hour) by mean viewer lifetime\n')
  console.log(`k  m | overhead | ${lifetimes.map((l) => `life ${l}s`.padStart(16)).join(' | ')} | degraded % (240s)`)
  console.log(`-----+----------+-${lifetimes.map(() => '-'.repeat(16)).join('-+-')}-+------------------`)
  for (const [k, m] of configs) {
    const cells: string[] = []
    let degraded = 0
    for (const l of lifetimes) {
      const r = run(k, m, l)
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
    `peers=${PEERS} seconds=${SECONDS} meanLifetime=${MEAN_LIFETIME_S}s repair=${REPAIR_MS}ms gossip=${GOSSIP_DELAY_MS}ms fanout=${MAX_FANOUT} bitrate=${BITRATE_KBPS}kbps hostUpload=${HOST_UPLOAD_KBPS}kbps\n`,
  )
  console.log('k  m | p50 ms | p95 ms | max depth | stall % | stalls/hr | degraded % | parent changes/min')
  console.log('-----+--------+--------+-----------+---------+-----------+------------+-------------------')
  for (const [k, m] of configs) console.log(fmtRow(run(k, m)))
}
