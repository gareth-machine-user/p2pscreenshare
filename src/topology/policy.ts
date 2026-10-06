// Publisher-side tree policy that is independent of networking: the planner's tuning, how long
// reattach requests are batched, and when a late parent loses its children. ChannelPublisher
// (session/publisher.ts) runs it for real; the simulator (sim/simulator.ts) runs the same code.
import type { PlannerConfig } from './model'

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

const lateKey = (parent: string, stripe: number) => `${parent}:${stripe}`

/**
 * Tracks how much later a parent's children receive a stripe than the parent itself does
 * (averaged over its children), and which parents have been late for too long.
 */
export class LateParentTracker {
  /** Excess lateness (ms) per `${parent}:${stripe}`, from the latest round of samples. */
  readonly lateness = new Map<string, number>()
  private lateSince = new Map<string, number>()

  /** A parent's excess lateness on a stripe (the planner's penalty). */
  get(parent: string, stripe: number): number {
    return this.lateness.get(lateKey(parent, stripe)) ?? 0
  }

  /**
   * Replaces the measurements with a new round of samples. Returns the parents (and stripes) late
   * by more than LATE_PARENT_MS for LATE_PARENT_FOR_MS: their children there should move elsewhere
   * for LATE_PARENT_AVOID_MS. Each is reported once, then its clock restarts.
   */
  update(samples: Iterable<LatenessSample>, now: number): { parent: string; stripe: number }[] {
    const sums = new Map<string, { total: number; n: number }>()
    for (const { parent, stripe, lateMs, parentLateMs } of samples) {
      const key = lateKey(parent, stripe)
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
