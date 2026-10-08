// Publisher-side tree policy that is independent of networking: the planner's tuning, how long
// reattach requests are batched, when a late parent loses its children, which keyframe requests
// are honoured, and when a child's complaint counts against its parent. ChannelPublisher
// (session/channelPublisher.ts) runs it for real; the simulator (sim/simulator.ts) runs the same code.
import { subtree, type PlannerConfig, type Topology } from './model'

/** Peers must have subscribed this long before they are trusted as relays (ms). */
export const MIN_UPTIME_MS_FOR_RELAY = 4000
/** Keep the current parent unless one this many levels shallower is available... */
export const SWITCH_GAIN = 1
/** ...or one at most as deep that is this much closer (RTT plus lateness, ms). */
export const RTT_SWITCH_MS = 40

/** A planner config with the app's hysteresis and relay-trust policy. */
export function defaultPlannerConfig(
  c: Pick<PlannerConfig, 'hostId' | 'k' | 'm' | 'rootSlots' | 'maxFanout'> & Partial<PlannerConfig>,
): PlannerConfig {
  return {
    minUptimeMsForRelay: MIN_UPTIME_MS_FOR_RELAY,
    switchGain: SWITCH_GAIN,
    rttSwitchMs: RTT_SWITCH_MS,
    ...c,
  }
}

/**
 * When a relay dies its whole subtree notices at about the same time. Reattach requests are
 * collected for this long and handled shallowest-first, so only the topmost complaint blames a
 * parent and the rest are recognized as collateral.
 */
export const REATTACH_BATCH_MS = 400

/**
 * A subscriber gives a new parent this long (from its set-parent) before asking to reattach. So a
 * reattach request the publisher gets sooner than this after changing that parent is about the
 * previous one: the child has been moved already.
 */
export const PARENT_GRACE_MS = 3000

/** A child whose linkOpen parent forwarded nothing avoids that parent this long (ms). */
export const SILENT_PARENT_AVOID_MS = 15_000
/** A child that could not link to its parent at all avoids that pair this long (ms). */
export const LINK_FAILED_AVOID_MS = 60_000
/**
 * After a relay fails, its whole subtree goes silent on that stripe. Descendants' reattach requests
 * within this window blame the upstream failure, not their (healthy) parent (ms).
 */
export const UPSTREAM_DISRUPTION_MS = 6000

/** Which peers' feeds of which stripes are known to be broken upstream, and until when. */
export class DisruptionTracker {
  /** edgeKey(peer, stripe) -> until when (ms). */
  private until = new Map<string, number>()

  /** `root`'s subtree on `stripe` (with `includeRoot`, root too) is about to go silent: not their parents' fault. */
  markSubtree(topology: Topology, root: string, stripe: number, now: number, includeRoot = false): void {
    const until = now + UPSTREAM_DISRUPTION_MS
    const nodes = subtree(topology, root, stripe)
    if (includeRoot) nodes.push(root)
    for (const n of nodes) {
      const key = edgeKey(n, stripe)
      this.until.set(key, Math.max(this.until.get(key) ?? 0, until))
    }
  }

  isDisrupted(peer: string, stripe: number, now: number): boolean {
    const key = edgeKey(peer, stripe)
    const until = this.until.get(key)
    if (until === undefined) return false
    if (now < until) return true
    this.until.delete(key)
    return false
  }

  /** The stripes (of `stripes`) on which `peer` is starved: PlannerPeer.starved. */
  starved(peer: string, stripes: number, now: number): number[] {
    return [...Array(stripes).keys()].filter((s) => this.isDisrupted(peer, s, now))
  }

  /** Drops expired entries. */
  prune(now: number): void {
    for (const [key, until] of this.until) if (now > until) this.until.delete(key)
  }
}

/** A child's reattach request: its parent on `stripe` forwarded nothing (`linkOpen`) or never linked. */
export interface ReattachRequest {
  child: string
  stripe: number
  linkOpen: boolean
  /** When the publisher received it (ms). */
  at: number
}

export interface ReattachBatchContext {
  hostId: string
  topology: Topology
  /** The last plan's depth[peer][stripe], to handle complaints shallowest-first. */
  depth: Record<string, number[]>
  /** In the current plan (subscribed, linked and answering). */
  isActive(child: string): boolean
  /** A subscriber of this channel (only those can be blamed as parents). */
  isPeer(id: string): boolean
  /** When `child`'s parent on `stripe` last changed (ms). */
  parentChangedAt(child: string, stripe: number): number | undefined
  disruption: DisruptionTracker
  now: number
}

/**
 * Handles one batch of reattach requests (ChannelPublisher's, and the simulator's), shallowest
 * first: requests about a parent that was replaced since, or about a parent whose own feed is
 * broken upstream, are dropped. Each remaining child's subtree (and the child) is marked disrupted,
 * so deeper complaints in the same batch are recognized as collateral. Returns whether to replan,
 * the linkOpen complaints to judge (judgeComplaints), and the parents each child should avoid.
 */
export function handleReattaches(
  batch: readonly ReattachRequest[],
  ctx: ReattachBatchContext,
): { replan: boolean; accused: Accusation[]; avoid: { child: string; parent: string; until: number }[] } {
  const depth = (r: ReattachRequest) => ctx.depth[r.child]?.[r.stripe] ?? 0
  const sorted = [...batch].sort((a, b) => depth(a) - depth(b))
  const { now } = ctx
  let replan = false
  const accused: Accusation[] = []
  const avoid: { child: string; parent: string; until: number }[] = []
  for (const { child, stripe, linkOpen, at } of sorted) {
    if (!ctx.isActive(child)) continue
    // Sent before the child heard of its new parent: it is about the old one, and handled.
    if (at - (ctx.parentChangedAt(child, stripe) ?? -Infinity) < PARENT_GRACE_MS) continue
    const parent = ctx.topology.parents[child]?.[stripe] ?? null
    // The parent is itself starved by an upstream failure that is already being handled:
    // keep this child where it is (the parent's feed will resume).
    if (linkOpen && parent && ctx.disruption.isDisrupted(parent, stripe, now)) continue
    // This child's feed is broken, and everything below it is going silent as well.
    ctx.disruption.markSubtree(ctx.topology, child, stripe, now, true)
    if (parent && parent !== ctx.hostId) {
      // Link up but nothing forwarded: the parent may be unreliable (judged by the caller).
      // Link not up: this pair can't connect (avoid it for longer).
      // Either way, pick a different parent for this stripe.
      if (linkOpen && ctx.isPeer(parent)) accused.push({ child, parent, stripe, now })
      avoid.push({ child, parent, until: now + (linkOpen ? SILENT_PARENT_AVOID_MS : LINK_FAILED_AVOID_MS) })
    }
    replan = true
  }
  return { replan, accused, avoid }
}

// Subscriber timing (session/subscription.ts), which the publisher's policy and the simulator assume.
/** A subscriber asks to reattach a stripe at most once per this long (ms). */
export const REATTACH_COOLDOWN_MS = 4000
/** At most one keyframe request per this interval (the decode chain often breaks in bursts, ms). */
export const KEY_REQUEST_INTERVAL_MS = 500
/** Subscribers send their stats this often (ms). */
export const STATS_INTERVAL_MS = 2000

/** A parent whose children's pieces arrive this much later than its own (ms)... */
export const LATE_PARENT_MS = 150
/** ...for this long (ms)... */
export const LATE_PARENT_FOR_MS = 10_000
/** ...loses those children: they avoid it this long (ms). */
export const LATE_PARENT_AVOID_MS = 30_000

/** One child's report for one stripe: how late it receives pieces, and how late its parent does. */
export interface LatenessSample {
  parent: string
  stripe: number
  /** The child's lateness on this stripe (ms). */
  lateMs: number
  /** The parent's own lateness on this stripe (ms), 0 if unknown. */
  parentLateMs: number
}

/** Key of one (peer, stripe) pair in per-edge maps. */
export const edgeKey = (peer: string, stripe: number): string => `${peer}:${stripe}`

/**
 * Tracks how much later a parent's children receive a stripe than the parent itself does
 * (averaged over its children), and which parents have been late for too long.
 */
export class LateParentTracker {
  /** Excess lateness (ms) per edgeKey(parent, stripe), from the latest round of samples. */
  readonly lateness = new Map<string, number>()
  private lateSince = new Map<string, number>()

  /** A parent's excess lateness on a stripe (the planner's penalty). */
  get(parent: string, stripe: number): number {
    return this.lateness.get(edgeKey(parent, stripe)) ?? 0
  }

  /**
   * Replaces the measurements with a new round of samples. Returns the parents (and stripes) late
   * by more than LATE_PARENT_MS for LATE_PARENT_FOR_MS: their children there should move elsewhere
   * for LATE_PARENT_AVOID_MS. Each is reported once, then its clock restarts.
   */
  update(samples: Iterable<LatenessSample>, now: number): { parent: string; stripe: number }[] {
    const sums = new Map<string, { total: number; n: number }>()
    for (const { parent, stripe, lateMs, parentLateMs } of samples) {
      const key = edgeKey(parent, stripe)
      const acc = sums.get(key) ?? { total: 0, n: 0 }
      acc.total += Math.max(0, lateMs - parentLateMs)
      acc.n++
      sums.set(key, acc)
    }
    this.lateness.clear()
    for (const [key, { total, n }] of sums) this.lateness.set(key, total / n)
    const evict: { parent: string; stripe: number }[] = []
    for (const [key, late] of this.lateness) {
      if (late <= LATE_PARENT_MS) {
        this.lateSince.delete(key)
        continue
      }
      const since = this.lateSince.get(key) ?? now
      this.lateSince.set(key, since)
      if (now - since < LATE_PARENT_FOR_MS) continue
      // Consistently late: its children on this stripe move elsewhere for a while.
      this.lateSince.delete(key)
      const i = key.lastIndexOf(':')
      evict.push({ parent: key.slice(0, i), stripe: Number(key.slice(i + 1)) })
    }
    for (const key of [...this.lateSince.keys()]) if (!this.lateness.has(key)) this.lateSince.delete(key)
    return evict
  }
}

// --- keyframe requests ---------------------------------------------------------------------------

export interface KeyframeGateConfig {
  /** A lone requester forces at most one keyframe per this long at first (ms)... */
  soloMinIntervalMs: number
  /** ...doubling each time it is served while it keeps asking, up to this (ms). */
  soloMaxIntervalMs: number
  /** Requests from this many distinct viewers within this window (ms)... */
  crowdWindowMs: number
  /** ...mean an upstream problem: honoured at once, whatever their backoff. */
  crowdMinRequesters: number
  /** No two forced keyframes closer than this (ms). */
  globalMinIntervalMs: number
}

/**
 * One viewer with a lossy downlink loses its decode chain over and over, and asks for a keyframe
 * every 500 ms (its own throttle). Keyframes are expensive for everyone (in constant-bitrate mode
 * each briefly blurs the picture), so a lone requester gets one at once, then one after 4 s, 8 s,
 * then every 10 s (the quality profile's scheduled interval) while it keeps asking: at most 7 in a
 * minute. Several viewers asking together are a real upstream loss, served immediately.
 */
export const DEFAULT_KEYFRAME_GATE: KeyframeGateConfig = {
  soloMinIntervalMs: 4000,
  soloMaxIntervalMs: 10_000,
  crowdWindowMs: 1000,
  crowdMinRequesters: 2,
  globalMinIntervalMs: 300,
}

interface KeyRequester {
  /** Its last request (ms). */
  lastAskAt: number
  /** It can't force another keyframe on its own before this (ms)... */
  holdUntil: number
  /** ...and the hold after the next keyframe that serves it (ms): doubles while it keeps asking. */
  interval: number
  /** When a keyframe last served it (ms). */
  servedAt: number
}

/**
 * Decides which keyframe requests the encoder honours. Requests that aren't honoured are not
 * queued: the viewer asks again (every 500 ms) or the next keyframe, forced or scheduled, serves
 * it. Any keyframe serves every viewer waiting at the time.
 */
export class KeyframeGate {
  private viewers = new Map<string, KeyRequester>()
  /** Viewers that asked since the last keyframe. */
  private waiting = new Set<string>()
  private lastKeyAt = -Infinity

  constructor(private cfg: KeyframeGateConfig = DEFAULT_KEYFRAME_GATE) {}

  /** A viewer asked for a keyframe at `now`. Returns true if the publisher should encode one now. */
  request(from: string, now: number): boolean {
    const c = this.cfg
    let v = this.viewers.get(from)
    if (!v) {
      v = { lastAskAt: -Infinity, holdUntil: -Infinity, interval: c.soloMinIntervalMs, servedAt: -Infinity }
      this.viewers.set(from, v)
    }
    // Quiet for a while: its decode chain recovered, so the next loss starts the backoff afresh.
    if (now - v.lastAskAt > 2 * v.interval) v.interval = c.soloMinIntervalMs
    v.lastAskAt = now
    this.waiting.add(from)
    if (now - this.lastKeyAt < c.globalMinIntervalMs) return false
    if (now >= v.holdUntil || this.crowd(now) >= c.crowdMinRequesters) {
      this.onKeyframe(now)
      return true
    }
    return false
  }

  /**
   * Distinct waiting viewers that asked within the crowd window. Viewers already served within
   * soloMinIntervalMs don't count: two chronically lossy viewers would otherwise always form a crowd
   * (they still do every soloMinIntervalMs, which bounds them).
   */
  private crowd(now: number): number {
    let n = 0
    for (const id of this.waiting) {
      const v = this.viewers.get(id)!
      if (now - v.lastAskAt <= this.cfg.crowdWindowMs && now - v.servedAt >= this.cfg.soloMinIntervalMs) n++
    }
    return n
  }

  /** A keyframe was produced (requested or scheduled): resets per-viewer state as appropriate. */
  onKeyframe(now: number): void {
    this.lastKeyAt = Math.max(this.lastKeyAt, now)
    // Everyone waiting is served; whoever asks again soon after is backing off.
    for (const id of this.waiting) {
      const v = this.viewers.get(id)!
      v.servedAt = now
      v.holdUntil = now + v.interval
      v.interval = Math.min(this.cfg.soloMaxIntervalMs, v.interval * 2)
    }
    this.waiting.clear()
  }

  forget(id: string): void {
    this.viewers.delete(id)
    this.waiting.delete(id)
  }
}

// --- blaming parents -----------------------------------------------------------------------------

/** Another child's complaint about the same parent within this window corroborates one (ms). */
export const SIBLING_COMPLAINT_MS = 10_000
/** A child complaining about two different parents within this window has a bad downlink (ms). */
export const OWN_LINK_COMPLAINT_MS = 3000
/** Subscriber stats (sent every 2 s) older than this say nothing about now (ms). */
export const STATS_MAX_AGE_MS = 5000

export interface BlameInput {
  /** The child's stats show this stripe silent while its other stripes still arrive. */
  childOtherStripesFresh: boolean
  /** Another child of the same parent (any stripe) complained recently, with no excuse. */
  siblingComplainedRecently: boolean
  /** The parent's own stats show its feed of this stripe silent (an upstream problem). */
  parentFeedStale: boolean
}

/**
 * Whether a child's "parent connected but forwarding nothing" complaint counts against the parent
 * (lowers its rank as a relay). The child moves regardless; this only decides whether one viewer's
 * report may push a relay down the tree for everyone. A starved parent is never blamed (it's
 * upstream); otherwise a corroborating sibling or the child's own other stripes still arriving
 * point at the parent. Without either, the child's own downlink is as likely the cause.
 */
export function shouldBlameParent(input: BlameInput): boolean {
  if (input.parentFeedStale) return false
  return input.siblingComplainedRecently || input.childOtherStripesFresh
}

/** A child's linkOpen reattach request: its parent on a stripe forwarded nothing. */
export interface Complaint {
  child: string
  parent: string
  stripe: number
  at: number
  /**
   * Not evidence against the parent: the child's own downlink looked bad, or the parent's own feed
   * was stale (it had nothing to forward).
   */
  excused: boolean
}

/** A subscriber's latest stats and when they were received (only the parts blame needs). */
export interface StatsSnapshot {
  at: number
  stripes: readonly { parent?: string | null; lastRecvAgoMs: number | null }[]
}

/** Recent complaints (SIBLING_COMPLAINT_MS), for corroboration. */
export class ComplaintLog {
  private list: Complaint[] = []

  add(c: Complaint): void {
    this.list.push(c)
  }

  recent(now: number): readonly Complaint[] {
    this.list = this.list.filter((c) => now - c.at <= SIBLING_COMPLAINT_MS)
    return this.list
  }

  /** Drops complaints by or about a peer that left. */
  forget(id: string): void {
    this.list = this.list.filter((c) => c.child !== id && c.parent !== id)
  }
}

const fresh = (ago: number | null | undefined, freshMs: number) => ago !== null && ago !== undefined && ago <= freshMs

/**
 * What the child's own reports say about its downlink when it complains about `stripe`:
 * - 'stale': it also complained about a different parent just now, or its stats show its other
 *   stripes silent too (its own downlink is failing);
 * - 'fresh': its stats show this stripe silent but every other stripe it has a parent for arriving
 *   (the parent is at fault);
 * - 'unknown': no recent stats, stats from before this stripe went silent (they show it still
 *   arriving, so they can't tell), or no other stripes (k + m = 1).
 * A stripe counts as arriving if its last fragment came at most `freshMs` before the stats.
 */
export function childStripeEvidence(
  c: { child: string; parent: string; stripe: number; now: number },
  childStats: StatsSnapshot | null,
  complaints: readonly Complaint[],
  freshMs: number,
): 'fresh' | 'stale' | 'unknown' {
  const multi = complaints.some(
    (o) => o.child === c.child && o.parent !== c.parent && o.stripe !== c.stripe && Math.abs(c.now - o.at) <= OWN_LINK_COMPLAINT_MS,
  )
  if (multi) return 'stale'
  if (!childStats || c.now - childStats.at > STATS_MAX_AGE_MS) return 'unknown'
  if (fresh(childStats.stripes[c.stripe]?.lastRecvAgoMs, freshMs)) return 'unknown'
  const others = childStats.stripes.filter((st, s) => s !== c.stripe && st.parent !== null)
  if (!others.length) return 'unknown'
  return others.every((st) => fresh(st.lastRecvAgoMs, freshMs)) ? 'fresh' : 'stale'
}

/**
 * Derives shouldBlameParent's input from plain data: the child's and parent's latest stats and the
 * recent complaints (which may include this one and the rest of its batch). Unknown evidence never
 * blames: no stats yet means no blame without a sibling, and missing parent stats don't excuse it.
 */
export function blameInput(
  c: { child: string; parent: string; stripe: number; now: number },
  childStats: StatsSnapshot | null,
  parentStats: StatsSnapshot | null,
  complaints: readonly Complaint[],
  freshMs: number,
): BlameInput {
  const parentSt = parentStats && c.now - parentStats.at <= STATS_MAX_AGE_MS ? parentStats.stripes[c.stripe] : undefined
  return {
    childOtherStripesFresh: childStripeEvidence(c, childStats, complaints, freshMs) === 'fresh',
    siblingComplainedRecently: complaints.some(
      (o) => o.parent === c.parent && o.child !== c.child && !o.excused && c.now - o.at <= SIBLING_COMPLAINT_MS,
    ),
    parentFeedStale: parentSt !== undefined && !fresh(parentSt.lastRecvAgoMs, freshMs),
  }
}

/** A child's linkOpen reattach request, as the publisher batches them. */
export interface Accusation {
  child: string
  parent: string
  stripe: number
  now: number
}

/**
 * Judges a batch of reattach complaints (ChannelPublisher's, and the simulator's): records each in
 * `log`, excused or not, and returns those that count against their parent (shouldBlameParent).
 * The whole batch is recorded first: a child complaining about several parents at once is its own
 * downlink's fault, and siblings in the same batch corroborate each other.
 */
export function judgeComplaints(
  accused: readonly Accusation[],
  log: ComplaintLog,
  statsOf: (id: string) => StatsSnapshot | null,
  now: number,
  freshMs: number,
): Accusation[] {
  const batch = [...log.recent(now), ...accused.map((c) => ({ ...c, at: c.now, excused: false }))]
  for (const c of accused) {
    const input = blameInput(c, statsOf(c.child), statsOf(c.parent), batch, freshMs)
    const excused = input.parentFeedStale || childStripeEvidence(c, statsOf(c.child), batch, freshMs) === 'stale'
    log.add({ ...c, at: c.now, excused })
  }
  const recent = log.recent(now)
  return accused.filter((c) => shouldBlameParent(blameInput(c, statsOf(c.child), statsOf(c.parent), recent, freshMs)))
}
