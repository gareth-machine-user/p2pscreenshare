// Gossip state: one signed record per member, merged by version, plus the failure detector.
// Pure (no DOM, no timers) so it can be unit tested.
import type { Envelope, Typed } from './envelope'
import type { StreamInfo } from '../proto/messages'

/** A channel: one encoding of one publisher's stream, announced in the publisher's record. */
export interface ChannelAnnouncement {
  /** Random u32, fresh each time the channel starts. */
  id: number
  kind: 'full' | 'preview'
  k: number
  m: number
  kbps: number
  /** Kbps of one stripe, including framing, signatures and (full channel) audio. */
  stripeKbps: number
  /** Decoder config, once the encoder has produced one. */
  stream: StreamInfo | null
  /** Relays this channel's latest plan had to overcommit (other peers shift budget towards it). */
  deficit: number
  /** Wall-clock start, to order a publisher's channels. */
  startedAt: number
}

export interface MemberRecord extends Typed {
  type: 'rec'
  id: string
  name: string
  /** Wall-clock time this peer joined the lobby. Orders door duty. */
  joinedAt: number
  /** Strictly increasing per author, across reloads (wall-clock based). */
  version: number
  /** Wall-clock time of publication. */
  heartbeat: number
  /** Measured upload estimate (kbps), null until measured. */
  capacityKbps: number | null
  /** Relay slots offered per channel id. */
  offers: Record<string, number>
  /** Channels this peer subscribes to. */
  subs: number[]
  /** Peers whose mesh link to this peer failed. */
  unreachable: string[]
  /** Mesh round-trip times (ms) to other peers. */
  rtt: Record<string, number>
  /** Channels this peer publishes. */
  channels: ChannelAnnouncement[]
  /** Uplink drop rate while relaying (0..1). */
  dropRate?: number
  /** Set on the final record of a peer leaving gracefully. */
  left?: boolean
}

export interface StoredRecord {
  rec: MemberRecord
  env: Envelope
  /** Local time this version arrived. */
  at: number
}

export type Digest = Record<string, number>

export class RecordStore {
  private map = new Map<string, StoredRecord>()
  /** Versions of departed peers: older copies still circulating must not resurrect them. */
  private tombstones = new Map<string, number>()

  get(id: string): StoredRecord | undefined {
    return this.map.get(id)
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  all(): StoredRecord[] {
    return [...this.map.values()]
  }

  ids(): string[] {
    return [...this.map.keys()]
  }

  /** Stores `rec` if it is newer than what we have. The caller has checked the signature and author. */
  accept(rec: MemberRecord, env: Envelope, now: number): boolean {
    const cur = this.map.get(rec.id)
    if (cur && cur.rec.version >= rec.version) return false
    if ((this.tombstones.get(rec.id) ?? -Infinity) >= rec.version) return false
    if (rec.left) {
      this.remove(rec.id, rec.version)
      return true
    }
    this.tombstones.delete(rec.id)
    this.map.set(rec.id, { rec, env, at: now })
    return true
  }

  /** Forgets a departed peer; copies of versions up to `version` are ignored from now on. */
  remove(id: string, version = this.map.get(id)?.rec.version ?? 0): void {
    this.map.delete(id)
    this.tombstones.set(id, Math.max(version, this.tombstones.get(id) ?? -Infinity))
  }

  digest(): Digest {
    const d: Digest = {}
    for (const [id, s] of this.map) d[id] = s.rec.version
    return d
  }

  /**
   * Anti-entropy against a neighbour's digest: the ids to pull (they have a newer version, or one
   * we don't know) and the envelopes to push (we have newer, or they lack it).
   */
  compare(remote: Digest): { pull: string[]; push: Envelope[] } {
    const pull: string[] = []
    const push: Envelope[] = []
    for (const [id, v] of Object.entries(remote)) {
      const mine = this.map.get(id)?.rec.version ?? this.tombstones.get(id) ?? -Infinity
      if (v > mine) pull.push(id)
    }
    for (const [id, s] of this.map) {
      if ((remote[id] ?? -Infinity) < s.rec.version) push.push(s.env)
    }
    return { pull, push }
  }
}

/**
 * Declares a peer gone when nothing fresh has been heard about it, from anyone, for `goneMs`:
 * neither a newer record (direct or forwarded) nor a direct pong. Pongs are answered from message
 * handlers, so a peer whose own timers are throttled (background tab) still counts as alive.
 */
export class FailureDetector {
  private lastHeard = new Map<string, number>()

  constructor(readonly goneMs = 6000) {}

  heard(id: string, now: number): void {
    this.lastHeard.set(id, Math.max(now, this.lastHeard.get(id) ?? -Infinity))
  }

  lastHeardAt(id: string): number | undefined {
    return this.lastHeard.get(id)
  }

  forget(id: string): void {
    this.lastHeard.delete(id)
  }

  /** Peers not heard from within the window. */
  gone(now: number): string[] {
    const out: string[] = []
    for (const [id, t] of this.lastHeard) if (now - t > this.goneMs) out.push(id)
    return out
  }
}

/**
 * Link-level suspicion (one direct link): suspected when it is closed, or a ping has gone
 * unanswered for `suspectMs`.
 */
export function linkSuspected(
  link: { open: boolean; pingSentAt: number | null; lastPongAt: number },
  now: number,
  suspectMs = 1500,
): boolean {
  if (!link.open) return true
  return link.pingSentAt !== null && link.pingSentAt > link.lastPongAt && now - link.pingSentAt > suspectMs
}

/** Door duty: the owner plus the `n` oldest present members (by join time, then id). */
export function doorPeers(members: { id: string; joinedAt: number }[], ownerId: string, n = 2): Set<string> {
  const others = members.filter((m) => m.id !== ownerId).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
  const doors = new Set(others.slice(0, n).map((m) => m.id))
  if (members.some((m) => m.id === ownerId)) doors.add(ownerId)
  return doors
}

/** Retry delay after the `attempt`-th failed mesh link: 60 s, doubling to 10 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(600_000, 60_000 * 2 ** Math.max(0, attempt - 1))
}
