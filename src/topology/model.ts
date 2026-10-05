export interface PlannerConfig {
  hostId: string
  /** Data stripes. */
  k: number
  /** Parity stripes. */
  m: number
  /** Bitrate of one stripe (≈ stream bitrate / k, plus framing overhead). */
  stripeKbps: number
  hostUploadKbps: number
  /** Fraction of measured upload capacity the planner is willing to use. */
  headroom: number
  /** Upper bound on children per peer, regardless of capacity. */
  maxFanout: number
  /** Peers must be connected this long before they are trusted as relays. */
  minUptimeMsForRelay: number
  /** Keep the current parent unless a parent this many levels shallower is available. */
  switchGain: number
}

export interface PlannerPeer {
  id: string
  /** Measured usable upload, null until measured. */
  capacityKbps: number | null
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
  /** Stripe in which the peer relays, or null if it is a leaf everywhere. */
  home: Record<string, number | null>
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
  /** Children slots per peer in its home stripe. */
  slots: Record<string, number>
}

export function emptyTopology(): Topology {
  return { parents: {}, home: {} }
}

export function stripeCount(c: Pick<PlannerConfig, 'k' | 'm'>): number {
  return c.k + c.m
}

/** Children of `id` in `stripe`, derived from the parent map. */
export function childrenOf(t: Topology, id: string, stripe: number): string[] {
  const out: string[] = []
  for (const [peer, ps] of Object.entries(t.parents)) if (ps[stripe] === id) out.push(peer)
  return out
}
