// Discrete-time simulation of the striped-tree planner under churn.
// Run: npm run sim [-- --peers 200 --seconds 300]
//
// Model (deliberately simple):
// - Each peer has a true upload capacity and an access latency; the planner sees a noisy estimate.
// - One-way hop latency = access(a) + access(b) + 10ms; serialization = piece bits / per-child rate.
// - A frame is decodable once any k of k+m stripes arrive -> latency = k-th fastest stripe path.
// - When a peer leaves, its descendants lose that stripe for REPAIR_MS (detect + replan + link setup).
//   A viewer stalls while it is missing more than m stripes.
// - Overloaded parents (children * stripe rate > true capacity) degrade their subtree.

import type { PlannerConfig, PlannerPeer, Topology } from '../src/topology/model'
import { emptyTopology } from '../src/topology/model'
import { plan } from '../src/topology/planner'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

const PEERS = Number(args.get('peers') ?? 200)
const SECONDS = Number(args.get('seconds') ?? 300)
const MEAN_LIFETIME_S = Number(args.get('lifetime') ?? 240)
const BITRATE_KBPS = 2500
const FPS = 30
const HOST_UPLOAD_KBPS = Number(args.get('host') ?? 10000)
const REPAIR_MS = 1000
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

function samplePeer(i: number, now: number): SimPeer {
  const r = rnd()
  // Rough residential mix: many weak uplinks, some strong.
  const trueKbps = r < 0.25 ? 500 : r < 0.6 ? 2000 : r < 0.85 ? 8000 : 30000
  return {
    id: `p${i}`,
    trueKbps,
    accessMs: 5 + rnd() * 45,
    joinedAt: now,
    leaveAt: now - Math.log(1 - rnd()) * MEAN_LIFETIME_S * 1000,
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
  degradedPct: number
  changesPerMin: number
}

function run(k: number, m: number): Result {
  seed = Number(args.get('seed') ?? 42)
  const S = k + m
  const stripeKbps = (BITRATE_KBPS / k) * 1.03
  const cfg: PlannerConfig = {
    hostId: HOST,
    k,
    m,
    stripeKbps,
    hostUploadKbps: HOST_UPLOAD_KBPS,
    headroom: 0.8,
    maxFanout: 16,
    minUptimeMsForRelay: 5000,
    switchGain: 1,
  }
  const access = new Map<string, number>([[HOST, 10]])
  const trueCap = new Map<string, number>([[HOST, HOST_UPLOAD_KBPS]])
  const estimate = new Map<string, number>()

  let nextId = 0
  const live = new Map<string, SimPeer>()
  const add = (now: number) => {
    const p = samplePeer(nextId++, now)
    live.set(p.id, p)
    access.set(p.id, p.accessMs)
    trueCap.set(p.id, p.trueKbps)
    estimate.set(p.id, p.trueKbps * (0.8 + rnd() * 0.3))
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
  let degradedTicks = 0
  let viewerTicks = 0

  const replan = (now: number) => {
    const peers: PlannerPeer[] = [...live.values()].map((p) => ({
      id: p.id,
      capacityKbps: now - p.joinedAt > 1500 ? estimate.get(p.id)! : null, // probe takes ~1.5s
      joinedAt: p.joinedAt,
      failures: 0,
      avoid: [],
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
          o[s] = Math.max(o[s], now + REPAIR_MS)
          outage.set(d, o)
        }
      }
      live.delete(p.id)
      outage.delete(p.id)
      departed = true
    }
    // Arrivals keep the audience roughly stable.
    while (live.size < PEERS) add(now)
    if (departed || now - lastPlan >= REPLAN_EVERY_MS) replan(now)

    // Load per parent per stripe.
    const load = new Map<string, number>()
    for (const ps of Object.values(topo.parents)) {
      ps.forEach((par) => par && load.set(par, (load.get(par) ?? 0) + 1))
    }

    const sampleLatency = now % 1000 === 0
    for (const p of live.values()) {
      if (now - p.joinedAt < 3000) continue // still joining
      viewerTicks++
      const o = outage.get(p.id)
      const missing = o ? o.filter((t) => t > now).length : 0
      if (missing > m) stallTicks++

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
          lat += access.get(par)! + access.get(cur)! + 10 + pieceBits / perChild
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
    degradedPct: (100 * degradedTicks) / viewerTicks,
    changesPerMin: changes / (SECONDS / 60),
  }
}

const configs: [number, number][] = [
  [1, 0],
  [2, 0],
  [4, 0],
  [4, 1],
  [4, 2],
  [8, 2],
]
console.log(
  `peers=${PEERS} seconds=${SECONDS} meanLifetime=${MEAN_LIFETIME_S}s bitrate=${BITRATE_KBPS}kbps hostUpload=${HOST_UPLOAD_KBPS}kbps\n`,
)
console.log('k  m | p50 ms | p95 ms | max depth | stall % | degraded % | parent changes/min')
console.log('-----+--------+--------+-----------+---------+------------+-------------------')
for (const [k, m] of configs) {
  const r = run(k, m)
  console.log(
    `${String(r.k).padEnd(2)} ${String(r.m).padEnd(1)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${String(r.maxDepth).padStart(9)} | ${r.stallPct.toFixed(3).padStart(7)} | ${r.degradedPct.toFixed(2).padStart(10)} | ${r.changesPerMin.toFixed(0).padStart(18)}`,
  )
}
