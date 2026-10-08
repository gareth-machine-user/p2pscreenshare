// Discrete-time simulation of the striped-tree planner under churn.
// Run: npm run sim [-- --peers 200 --seconds 300 --lifetime 240 --repair 2225 --gossip 500]
//      npm run sim -- --sweep parity     (stall vs parity across churn levels)
//      npm run sim -- --sweep lossy      (one viewer with a bad downlink: old vs new policy)
// `simulate()` and `simulateLossy()` are exported for tests/sim.test.ts.
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
//   A viewer stalls while it is missing more than m stripes (in an outage, or with no parent at all).
// - Overloaded parents (children * stripe rate > true capacity) degrade their subtree.
// - simulateLossy() adds viewers with a bad downlink (LossyOptions) and runs the publisher's
//   complaint and keyframe-request handling on them, old or new policy.

import { pathToFileURL } from 'node:url'
import { HEADROOM, MAX_FANOUT, rebalanceWeights, splitBudget, stripeKbpsFor } from '../src/session/capacity'
import type { PlannerConfig, PlannerPeer, Topology } from '../src/topology/model'
import { emptyTopology, subtree } from '../src/topology/model'
import { plan } from '../src/topology/planner'
import {
  ComplaintLog,
  defaultPlannerConfig,
  edgeKey,
  KEY_REQUEST_INTERVAL_MS,
  KeyframeGate,
  LATE_PARENT_AVOID_MS,
  judgeComplaints,
  LateParentTracker,
  PARENT_GRACE_MS,
  REATTACH_BATCH_MS,
  REATTACH_COOLDOWN_MS,
  SILENT_PARENT_AVOID_MS,
  STATS_INTERVAL_MS,
  UPSTREAM_DISRUPTION_MS,
  type Accusation,
  type LatenessSample,
  type StatsSnapshot,
} from '../src/topology/policy'
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

/** Lossy viewers (simulateLossy): the publisher's keyframe throttle before KeyframeGate, one per 300 ms from anyone. */
const OLD_KEY_MIN_INTERVAL_MS = 300

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
  /** Viewers with a bad downlink (simulateLossy only). */
  lossy?: LossyOptions
}

/**
 * A viewer with a bad downlink (a model, not a measurement). Every stripe goes silent at once for
 * 1–3 s, every `outageGapS` seconds on average (exponential gaps); in between, short bursts of
 * unrecoverable loss (0.1–0.4 s, every `burstGapS` on average) hit every stripe too; and each
 * stripe also stalls on its own for 1.5–3 s every `stripeStallGapS` seconds on average. Lossy
 * viewers never leave and offer no relay slots (leaves). Losing every stripe breaks the decode
 * chain; one stripe stalling is covered by parity (m ≥ 1). Only silences of stripeSilenceMs or
 * more lead to reattach complaints.
 */
export interface LossyOptions {
  /** How many viewers are lossy. */
  count: number
  /** 'old': every linkOpen complaint counts against the parent, and one global 300 ms keyframe
   *  throttle. 'new': corroborated blame and KeyframeGate (topology/policy.ts). */
  policy: 'old' | 'new'
  outageGapS?: number
  burstGapS?: number
  stripeStallGapS?: number
  /**
   * Model of parent GOP replay: when the lossy viewer's stripes come back after breaking its
   * decode chain, it recovers from its parents' cached GOP with this probability and sends no
   * keyframe requests. Otherwise it asks the publisher every 500 ms until a keyframe arrives.
   */
  replayP?: number
}

export interface LossyMetrics extends SimMetrics {
  /** Keyframes forced by requests (not scheduled), across the lobby, per minute. */
  forcedKeysPerMin: number
  /** Failure scores of healthy relays (peers with children), mean over samples and maximum. */
  relayFailuresMean: number
  relayFailuresMax: number
  /** Share of the lossy viewers' time without a decodable picture (%). */
  lossyFrozenPct: number
  /** Reattach complaints the lossy viewers sent, per minute. */
  complaintsPerMin: number
}

const LOSSY_DEFAULTS = { outageGapS: 6, burstGapS: 10, stripeStallGapS: 30, replayP: 0 }
/** From a keyframe being requested (or scheduled) to it reaching a viewer: request, encode, transit. */
const KEYFRAME_ARRIVAL_MS = 400

interface LossyViewer {
  id: string
  rnd: Rng
  outageFrom: number
  outageUntil: number
  nextOutageAt: number
  burstUntil: number
  nextBurstAt: number
  stallUntil: number[]
  nextStallAt: number[]
  /** Subscriber-side state, as in session/subscription.ts. */
  parents: (string | null)[]
  setAt: number[]
  lastRecv: number[]
  lastReattach: number[]
  lastAsk: number
  stats: StatsSnapshot | null
  /** Decode chain broken: waiting for a keyframe (or a replayed GOP). */
  broken: boolean
  wasDecodable: boolean
  frozenTicks: number
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
  /** When each of those outages began (lossy runs only, for relays' stats). */
  private readonly outageFrom = new Map<string, number[]>()
  /** edgeKey(peer, stripe) -> until when the publisher knows that feed is starved by a departure. */
  private readonly disruptedUntil = new Map<string, number>()

  // Lossy viewers and the publisher policy they exercise (simulateLossy only).
  private readonly lossy = new Map<string, LossyViewer>()
  private readonly failures = new Map<string, number>()
  private readonly keyGate = new KeyframeGate()
  private readonly complaints = new ComplaintLog()
  private readonly reattachQueue: { child: string; parent: string; stripe: number }[] = []
  private reattachDueAt = Infinity
  private lastKeyAt = 0
  /** When encoded keyframes reach the lossy viewers. */
  private keyArrivals: number[] = []
  private lastForcedAt = -Infinity
  private forcedKeys = 0
  private complaintsSent = 0
  private readonly relayFailures: number[] = []

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
    if (o.lossy) {
      // The first few of the existing audience have a bad downlink. Their losses come from their
      // own random streams, so every policy sees the same losses and the same churn.
      const S = this.S
      for (const p of [...this.live.values()].slice(0, o.lossy.count)) {
        p.leaveAt = Infinity
        const rnd = makeRng(o.seed * 7919 + Number(p.id.slice(1)) + 1)
        this.lossy.set(p.id, {
          id: p.id,
          rnd,
          outageFrom: -Infinity,
          outageUntil: -Infinity,
          nextOutageAt: 0,
          burstUntil: -Infinity,
          nextBurstAt: 0,
          stallUntil: new Array(S).fill(-Infinity),
          nextStallAt: new Array(S).fill(0),
          parents: new Array(S).fill(null),
          setAt: new Array(S).fill(0),
          lastRecv: new Array(S).fill(0),
          lastReattach: new Array(S).fill(-Infinity),
          lastAsk: -Infinity,
          stats: null,
          broken: false,
          wasDecodable: true,
          frozenTicks: 0,
        })
      }
      for (const v of this.lossy.values()) {
        v.nextOutageAt = this.expMs(v.rnd, this.lossyOpt.outageGapS)
        v.nextBurstAt = this.expMs(v.rnd, this.lossyOpt.burstGapS)
        for (let s = 0; s < S; s++) v.nextStallAt[s] = this.expMs(v.rnd, this.lossyOpt.stripeStallGapS)
      }
    }
  }

  private get lossyOpt(): Required<LossyOptions> {
    return { ...LOSSY_DEFAULTS, ...stripUndefined(this.o.lossy!) }
  }

  private expMs(rnd: Rng, meanS: number): number {
    return -Math.log(1 - rnd()) * meanS * 1000
  }

  run(): SimMetrics {
    this.replan(0)
    for (let now = 0; now < this.o.seconds * 1000; now += TICK_MS) {
      this.churn(now)
      if (this.lossy.size) this.stepLossy(now)
      this.observe(now)
    }
    return this.metrics()
  }

  runLossy(): LossyMetrics {
    const base = this.run()
    const minutes = this.o.seconds / 60
    const viewers = [...this.lossy.values()]
    const ticks = (this.o.seconds * 1000) / TICK_MS
    return {
      ...base,
      forcedKeysPerMin: this.forcedKeys / minutes,
      relayFailuresMean: this.relayFailures.length ? this.relayFailures.reduce((a, b) => a + b, 0) / this.relayFailures.length : 0,
      relayFailuresMax: Math.max(0, ...this.relayFailures),
      lossyFrozenPct: (100 * viewers.reduce((a, v) => a + v.frozenTicks, 0)) / (viewers.length * ticks),
      complaintsPerMin: this.complaintsSent / minutes,
    }
  }

  // --- lossy viewers ---------------------------------------------------------------------------

  /** One tick of the lossy viewers' downlinks, their subscriber logic, and the publisher's reaction. */
  private stepLossy(now: number): void {
    const { k } = this.o
    const opt = this.lossyOpt
    for (const v of this.lossy.values()) {
      // The downlink: all-stripe outages, all-stripe loss bursts and single-stripe stalls.
      if (now >= v.nextOutageAt) {
        v.outageFrom = now
        v.outageUntil = now + 1000 + 2000 * v.rnd()
        v.nextOutageAt = v.outageUntil + this.expMs(v.rnd, opt.outageGapS)
      }
      if (now >= v.nextBurstAt) {
        v.burstUntil = now + 100 + 300 * v.rnd()
        v.nextBurstAt = v.burstUntil + this.expMs(v.rnd, opt.burstGapS)
      }
      const burst = now < v.burstUntil
      const churnOutage = this.outage.get(v.id)
      let arriving = 0
      for (let s = 0; s < this.S; s++) {
        if (now >= v.nextStallAt[s]) {
          v.stallUntil[s] = now + 1500 + 1500 * v.rnd()
          v.nextStallAt[s] = v.stallUntil[s] + this.expMs(v.rnd, opt.stripeStallGapS)
        }
        const parent = this.topo.parents[v.id]?.[s] ?? null
        if (parent !== v.parents[s]) {
          v.parents[s] = parent
          v.setAt[s] = now
        }
        const silent = !parent || (now >= v.outageFrom && now < v.outageUntil) || now < v.stallUntil[s] || (churnOutage?.[s] ?? -Infinity) > now
        if (!silent) {
          v.lastRecv[s] = now
          if (!burst) arriving++
        }
        // Health check (session/subscription.ts): a stripe silent too long means a bad parent.
        if (parent && now - v.setAt[s] >= PARENT_GRACE_MS && now - v.lastRecv[s] >= tuning.stripeSilenceMs && now - v.lastReattach[s] >= REATTACH_COOLDOWN_MS) {
          v.lastReattach[s] = now
          this.complaintsSent++
          this.reattachQueue.push({ child: v.id, parent, stripe: s })
          if (this.reattachDueAt === Infinity) this.reattachDueAt = now + REATTACH_BATCH_MS
        }
      }
      if (now % STATS_INTERVAL_MS === Math.floor(coin(v.id, 3) * 20) * TICK_MS) {
        // Stats every 2 s (the same phase statsOf assumes for healthy peers).
        v.stats = { at: now, stripes: v.parents.map((parent, s) => ({ parent, lastRecvAgoMs: now - v.lastRecv[s] })) }
      }
      // Decoding: fewer than k stripes loses frames and breaks the chain.
      const decodable = arriving >= k
      if (!decodable) v.broken = true
      else if (v.broken && !v.wasDecodable && opt.replayP > 0 && v.rnd() < opt.replayP) v.broken = false // replayed GOP
      v.wasDecodable = decodable
      if (v.broken && decodable && now - v.lastAsk >= KEY_REQUEST_INTERVAL_MS) {
        v.lastAsk = now
        if (this.keyRequest(v.id, now)) this.keyframe(now, true)
      }
      if (v.broken && decodable && this.keyArrivals.some((t) => t <= now)) v.broken = false
      if (v.broken || !decodable) v.frozenTicks++
    }
    // Scheduled keyframes (the encoder's interval restarts after any keyframe).
    if (now - this.lastKeyAt >= tuning.keyframeIntervalMs) this.keyframe(now, false)
    this.keyArrivals = this.keyArrivals.filter((t) => t > now)
    if (now >= this.reattachDueAt) this.processReattaches(now)
    if (now % 1000 === 0) this.sampleRelayFailures()
  }

  /** The publisher receives need-key: whether to force a keyframe now. */
  private keyRequest(from: string, now: number): boolean {
    if (this.o.lossy!.policy === 'new') return this.keyGate.request(from, now)
    if (now - this.lastForcedAt <= OLD_KEY_MIN_INTERVAL_MS) return false
    this.lastForcedAt = now
    return true
  }

  /** A keyframe is encoded; it repairs the decode chain of every viewer receiving it when it arrives. */
  private keyframe(now: number, forced: boolean): void {
    this.lastKeyAt = now
    if (forced) this.forcedKeys++
    this.keyGate.onKeyframe(now)
    this.keyArrivals.push(now + KEYFRAME_ARRIVAL_MS)
  }

  /** ChannelPublisher.processReattaches for linkOpen complaints: move the child, maybe blame the parent. */
  private processReattaches(now: number): void {
    this.reattachDueAt = Infinity
    const accused: Accusation[] = []
    for (const { child, parent, stripe } of this.reattachQueue.splice(0)) {
      if (this.topo.parents[child]?.[stripe] !== parent || parent === HOST) continue
      // The parent is starved by a departure being repaired: the child stays (as the publisher does).
      if ((this.disruptedUntil.get(edgeKey(parent, stripe)) ?? -Infinity) > now) continue
      if (this.live.has(parent)) accused.push({ child, parent, stripe, now })
      const m = this.avoidUntil.get(child) ?? new Map<string, number>()
      m.set(parent, now + SILENT_PARENT_AVOID_MS)
      this.avoidUntil.set(child, m)
    }
    if (this.o.lossy!.policy === 'new') {
      // The publisher's own judgement (topology/policy.ts), one entry per blamed complaint.
      const blamed = judgeComplaints(accused, this.complaints, (id) => this.statsOf(id, now), now, tuning.stripeSilenceMs / 2)
      for (const { parent: p } of blamed) this.failures.set(p, (this.failures.get(p) ?? 0) + 1)
    } else {
      // Before corroboration: every complaint counted against the parent.
      for (const c of accused) this.failures.set(c.parent, (this.failures.get(c.parent) ?? 0) + 1)
    }
    this.replan(now)
  }

  /** A peer's latest stats as the publisher has them (sent every 2 s). */
  private statsOf(id: string, now: number): StatsSnapshot | null {
    const v = this.lossy.get(id)
    if (v) return v.stats
    if (!this.live.has(id)) return null
    // A healthy peer: its stripes arrive except while an upstream departure is being repaired.
    const phase = Math.floor(coin(id, 3) * 20) * TICK_MS
    const at = now - ((((now - phase) % STATS_INTERVAL_MS) + STATS_INTERVAL_MS) % STATS_INTERVAL_MS)
    const until = this.outage.get(id)
    const from = this.outageFrom.get(id)
    return {
      at,
      stripes: Array.from({ length: this.S }, (_, s) => ({
        parent: this.topo.parents[id]?.[s] ?? null,
        lastRecvAgoMs: until && from && from[s] <= at && until[s] > at ? at - from[s] : 0,
      })),
    }
  }

  private sampleRelayFailures(): void {
    const relays = new Set<string>()
    for (const ps of Object.values(this.topo.parents)) for (const par of ps) if (par && par !== HOST) relays.add(par)
    for (const id of relays) if (!this.lossy.has(id)) this.relayFailures.push(this.failures.get(id) ?? 0)
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
          if (this.lossy.size) {
            const from = this.outageFrom.get(d) ?? new Array(this.S).fill(-Infinity)
            if (o[s] <= now) from[s] = now
            this.outageFrom.set(d, from)
            this.disruptedUntil.set(edgeKey(d, s), now + UPSTREAM_DISRUPTION_MS)
          }
          o[s] = Math.max(o[s], now + this.o.repairMs)
          this.outage.set(d, o)
        }
      }
      this.live.delete(p.id)
      this.outage.delete(p.id)
      this.outageFrom.delete(p.id)
      this.failures.delete(p.id)
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
    for (const [id, f] of this.failures) this.failures.set(id, f * 0.95)
    // Departures are seen at once (the publisher's own mesh links); joins and offers through gossip.
    const peers: PlannerPeer[] = [...this.live.values()]
      .filter((p) => now - p.joinedAt >= this.o.gossipMs)
      .map((p) => ({
        id: p.id,
        slots: this.lossy.has(p.id) ? 0 : this.offerFor(p.id, now),
        joinedAt: p.joinedAt,
        failures: this.failures.get(p.id) ?? 0,
        avoid: [...(this.avoidUntil.get(p.id) ?? new Map<string, number>())].filter(([, t]) => t > now).map(([a]) => a),
      }))
    const r = plan(peers, this.topo, this.cfg, now)
    // With lossy viewers, count only the other viewers' changes.
    this.changes += r.changes.filter((c) => !this.lossy.has(c.peer)).length
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
    // Children per parent, across all stripes (its whole uplink is shared between them).
    const load = new Map<string, number>()
    for (const ps of Object.values(this.topo.parents)) {
      ps.forEach((par) => par && load.set(par, (load.get(par) ?? 0) + 1))
    }
    const pieceBits = (this.stripeKbps * 1000) / FPS
    const sampleLatency = now % 1000 === 0
    for (const p of this.live.values()) {
      if (now - p.joinedAt < 3000 + this.o.gossipMs) continue // still joining
      if (this.lossy.has(p.id)) continue // measured separately
      this.viewerTicks++
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
      // Missing: in an outage, or not attached to the tree at all (e.g. shed to k stripes by the
      // planner, which leaves no parity to absorb the next loss).
      const o = this.outage.get(p.id)
      let missing = 0
      for (let s = 0; s < this.S; s++) if ((o?.[s] ?? -Infinity) > now || !Number.isFinite(stripeLat[s])) missing++
      if (missing > m) {
        this.stallTicks++
        if (!this.stalled.has(p.id)) {
          this.stalled.add(p.id)
          this.stallEvents++
        }
      } else {
        this.stalled.delete(p.id)
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
  return new Simulation({ ...DEFAULTS, ...stripUndefined(opts), lossy: undefined }).run()
}

/**
 * The same scenario with `lossy.count` viewers on a bad downlink, under the old or new publisher
 * policy. The SimMetrics fields describe the other viewers only (parent changes, latency, stalls).
 */
export function simulateLossy(opts: SimOptions & { lossy: LossyOptions }): LossyMetrics {
  return new Simulation({ ...DEFAULTS, ...stripUndefined(opts) }).runLossy()
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
  } else if (sweep === 'lossy') {
    // Viewers with a bad downlink: what they cost everyone else under the old and new policy.
    const gap = num('outage-gap') ?? LOSSY_DEFAULTS.outageGapS
    console.log(
      `peers=${o.peers} seconds=${o.seconds} 4+1 stripes; lossy viewers lose every stripe for 1-3 s every ~${gap} s and single stripes for 1.5-3 s every ~${LOSSY_DEFAULTS.stripeStallGapS} s\n`,
    )
    console.log('lossy | policy | replay | forced keys/min | relay failures mean / max | others: changes/min | p50 ms | p95 ms | stall % | lossy frozen %')
    console.log('------+--------+--------+-----------------+---------------------------+---------------------+--------+--------+---------+---------------')
    const row = (count: number, policy: string, replay: string, r: SimMetrics, l?: LossyMetrics) =>
      console.log(
        `${String(count).padStart(5)} | ${policy.padStart(6)} | ${replay.padStart(6)} | ${(l ? l.forcedKeysPerMin.toFixed(1) : '-').padStart(15)} | ${(l ? `${l.relayFailuresMean.toFixed(3)} / ${l.relayFailuresMax.toFixed(2)}` : '-').padStart(25)} | ${r.changesPerMin.toFixed(1).padStart(19)} | ${r.p50.toFixed(0).padStart(6)} | ${r.p95.toFixed(0).padStart(6)} | ${r.stallPct.toFixed(3).padStart(7)} | ${(l ? l.lossyFrozenPct.toFixed(1) : '-').padStart(14)}`,
      )
    row(0, '-', '-', simulate({ ...base, k: 4, m: 1 }))
    for (const count of [1, 3]) {
      for (const [policy, replayP] of [
        ['old', 0],
        ['new', 0],
        ['new', 0.7],
      ] as const) {
        const r = simulateLossy({ ...base, k: 4, m: 1, lossy: { count, policy, replayP, outageGapS: gap } })
        row(count, policy, replayP ? `p=${replayP}` : 'no', r, r)
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
