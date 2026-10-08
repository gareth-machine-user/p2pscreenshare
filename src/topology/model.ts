export interface PlannerConfig {
  /** The tree root: the channel's publisher. */
  hostId: string
  /** Data stripes. */
  k: number
  /** Parity stripes. */
  m: number
  /** The publisher's child slots for this channel (its budget / stripe bitrate); at least one per stripe. */
  rootSlots: number
  /** Upper bound on children per peer, regardless of capacity. */
  maxFanout: number
  /** Peers must have subscribed this long before they are trusted as relays. */
  minUptimeMsForRelay: number
  /** Keep the current parent unless a parent this many levels shallower is available... */
  switchGain: number
  /** ...or one at most as deep that is this much closer (RTT plus lateness penalty, ms). */
  rttSwitchMs: number
  /** Round-trip time between two peers (ms), when known. Ties between equally deep parents go to the closest. */
  rtt?: (a: string, b: string) => number | null
  /** How late a parent's deliveries arrive on a stripe (ms), added to its RTT as a penalty. */
  lateness?: (parent: string, stripe: number) => number
}

export interface PlannerPeer {
  id: string
  /** Child slots this peer offers for this channel (from its gossip record). */
  slots: number
  joinedAt: number
  /** Recent failures while acting as a parent (lowers rank). */
  failures: number
  /** Peers this peer could not establish a link with. */
  avoid: string[]
  /** Stripes this peer is currently not receiving (it must not be picked as a new parent there). */
  starved?: number[]
}

export interface Topology {
  /** parents[peerId][stripe] = parent id (host id or peer id), or null when unattached. */
  parents: Record<string, (string | null)[]>
  /** Stripes in which the peer relays, its first home first; empty if it is a leaf everywhere. */
  homes: Record<string, number[]>
}

export interface ParentChange {
  peer: string
  stripe: number
  from: string | null
  to: string | null
}

export interface PlanResult {
  topology: Topology
  changes: ParentChange[]
  /** depth[peerId][stripe], host children have depth 1. */
  depth: Record<string, number[]>
  /** Attachments that exceed some parent's estimated capacity. */
  overcommitted: number
  /**
   * (peer, stripe) pairs left without a parent because no placed relay (nor the root) could link
   * to the peer. Stripes shed on purpose (parity covers them) are not counted.
   */
  unattached: number
  /** Children slots per peer, across its home stripes. */
  slots: Record<string, number>
}

export function emptyTopology(): Topology {
  return { parents: {}, homes: {} }
}

export function stripeCount(c: Pick<PlannerConfig, 'k' | 'm'>): number {
  return c.k + c.m
}

/**
 * Everything below `root` in `stripe` (not including `root` itself), derived from the parent map.
 * Safe on malformed maps: each peer is visited once.
 */
export function subtree(t: Topology, root: string, stripe: number): string[] {
  const kids = new Map<string, string[]>()
  for (const [peer, ps] of Object.entries(t.parents)) {
    const par = ps[stripe]
    if (!par) continue
    const list = kids.get(par)
    if (list) list.push(peer)
    else kids.set(par, [peer])
  }
  const out: string[] = []
  const seen = new Set<string>([root])
  const stack = [...(kids.get(root) ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    out.push(n)
    stack.push(...(kids.get(n) ?? []))
  }
  return out
}
