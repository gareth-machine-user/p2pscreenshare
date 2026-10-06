import { decodeFragment, peekIsKey, peekLayer, withReplayFlag, type Fragment, type FragmentHeader } from '../proto/framing'
import type { MediaLink } from '../net/link'
import { after } from '../net/ticker'
import type { Uplink } from '../net/uplink'
import { tuning } from '../tuning'

const SEEN_RETAIN_MS = 5000
/**
 * Oldest a replayed (GOP-cache) fragment may be, behind the newest seen on its channel: a GOP is at
 * most one keyframe interval long. The replay flag isn't signed (relays set it), so without a bound
 * any relay could pass off old signed video as a replay.
 */
const REPLAY_MAX_LAG_MS = tuning.keyframeIntervalMs + SEEN_RETAIN_MS
/** Per tree. A 10 s GOP of a 16 Mbps stream in 4 data stripes is about 5 MB per stripe. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024
/** Replayed GOP fragments may wait longer in the queue than live ones. */
const REPLAY_MAX_AGE_MS = tuning.replayMaxAgeMs
/**
 * Keyframe fragments may wait longer than other base-layer fragments: a late keyframe still unlocks
 * every frame after it, while dropping one leaves an overloaded child unable to decode at all.
 */
const KEY_MAX_AGE_MS = tuning.keyMaxAgeMs
/** A child's cached-GOP replays (attach or `need-gop`) are at least this far apart, per stripe. */
export const REPLAY_REQUEST_MIN_MS = 2000
/**
 * After asking a parent for a replay, replayed fragments are accepted for local playback for this
 * long even if already seen: the decoder needs the GOP's keyframe again, which arrived long ago.
 */
const REPAIR_WINDOW_MS = REPLAY_MAX_AGE_MS + 1000

interface StripeCache {
  gopId: number
  epoch: number
  frags: Uint8Array[]
  bytes: number
}

/**
 * Whether (epoch, gopId) comes after the cached GOP. Epochs (u16) and gopIds (u32 frame seqs,
 * continuing across epochs) are compared as serial numbers, so wraparound is handled.
 */
function gopNewer(epoch: number, gopId: number, c: StripeCache): boolean {
  if (epoch !== c.epoch) return ((epoch - c.epoch) & 0xffff) < 0x8000
  return gopId !== c.gopId && (gopId - c.gopId) >>> 0 < 0x80000000
}

/** A (channel, stripe) pair: one tree. */
export const treeKey = (channel: number, stripe: number) => `${channel >>> 0}:${stripe}`

const fragId = (h: FragmentHeader) =>
  `${h.channel >>> 0}:${h.audio ? 'a' : 'v'}${h.stripe}:${h.epoch}:${h.frameSeq}:${h.pieceIdx}:${h.fragIdx}`

/**
 * Forwards fragments verbatim to children (cut-through, per channel and stripe), de-duplicates
 * (e.g. while two parents overlap during make-before-break), and keeps a cache of the current GOP
 * per (channel, stripe) so a newly attached child can start decoding immediately (and a child whose
 * decode chain broke can recover without a new keyframe, see requestReplay). Received
 * fragments are only forwarded or played once the channel publisher's signature verifies.
 */
export class RelayNode {
  private children = new Map<string, Set<string>>()
  private seen = new Map<string, number>()
  private lastSeenPrune = 0
  private caches = new Map<string, StripeCache>()
  /** When each (tree, child) was last replayed the cache. */
  private lastReplay = new Map<string, number>()
  /** Per tree: until when replayed duplicates are delivered locally (see expectReplay). */
  private repairUntil = new Map<string, number>()
  /** Local time of the last fragment received per tree. */
  readonly lastRecv = new Map<string, number>()
  /** Who delivered the last fragment per tree. */
  readonly lastFrom = new Map<string, string>()

  /** Called for every new (non-duplicate) fragment, for local playback. */
  onFragment: (frag: Fragment, from: string) => void = () => {}
  /**
   * Checks a received fragment against its channel publisher's signature (and that the publisher
   * may publish). Unset: nothing received is accepted.
   */
  verifier: ((raw: Uint8Array, channel: number) => Promise<boolean>) | null = null
  /** Received fragments dropped for a bad signature, an unknown channel, or being stale. */
  rejected = 0
  /** Newest capture time among verified fragments, per channel. */
  private newestCapture = new Map<number, number>()

  constructor(
    private uplink: Uplink,
    private linkFor: (peerId: string) => MediaLink | undefined,
  ) {}

  childrenOf(channel: number, stripe: number): string[] {
    return [...(this.children.get(treeKey(channel, stripe)) ?? [])]
  }

  /** Every child in every tree (or in one channel's trees). */
  allChildren(channel?: number): Set<string> {
    const out = new Set<string>()
    const prefix = channel === undefined ? null : `${channel >>> 0}:`
    for (const [key, set] of this.children) if (prefix === null || key.startsWith(prefix)) for (const c of set) out.add(c)
    return out
  }

  addChild(channel: number, stripe: number, child: string): void {
    const key = treeKey(channel, stripe)
    let set = this.children.get(key)
    if (!set) {
      set = new Set()
      this.children.set(key, set)
    }
    if (set.has(child)) return
    set.add(child)
    this.replayTo(key, child)
  }

  /**
   * A child's decode chain broke (`need-gop`): replays the cached GOP of each stripe it is our
   * child on, at most once per REPLAY_REQUEST_MIN_MS. Requests from anyone else are ignored.
   */
  requestReplay(channel: number, stripes: number[], child: string): void {
    const link = this.linkFor(child)
    if (!link?.isOpen) return
    for (const stripe of new Set(stripes)) {
      const key = treeKey(channel, stripe)
      if (!this.children.get(key)?.has(child) || this.replayedRecently(key, child)) continue
      this.noteReplay(key, child)
      this.sendCache(key, link)
    }
  }

  /**
   * We asked our parents for a replay: for a while, replayed fragments on these trees reach local
   * playback even if already seen (they are still neither forwarded nor cached again).
   */
  expectReplay(channel: number, stripes: number[]): void {
    const until = performance.now() + REPAIR_WINDOW_MS
    for (const stripe of stripes) this.repairUntil.set(treeKey(channel, stripe), until)
  }

  private repairing(h: FragmentHeader): boolean {
    return h.replay && (this.repairUntil.get(treeKey(h.channel, h.stripe)) ?? 0) > performance.now()
  }

  private replayedRecently(key: string, child: string): boolean {
    return performance.now() - (this.lastReplay.get(`${key}:${child}`) ?? -Infinity) < REPLAY_REQUEST_MIN_MS
  }

  private noteReplay(key: string, child: string): void {
    const now = performance.now()
    if (this.lastReplay.size > 1000) for (const [k, t] of this.lastReplay) if (now - t >= REPLAY_REQUEST_MIN_MS) this.lastReplay.delete(k)
    this.lastReplay.set(`${key}:${child}`, now)
  }

  removeChild(channel: number, stripe: number, child: string): void {
    this.children.get(treeKey(channel, stripe))?.delete(child)
  }

  /** Stops forwarding to a peer, in every channel or in one. */
  removePeer(peer: string, channel?: number): void {
    const prefix = channel === undefined ? null : `${channel >>> 0}:`
    for (const [key, set] of this.children) if (prefix === null || key.startsWith(prefix)) set.delete(peer)
  }

  /** Forgets everything about a channel (it ended, or this peer unsubscribed or was revoked). */
  dropChannel(channel: number): void {
    const prefix = `${channel >>> 0}:`
    for (const map of [this.children, this.caches, this.lastRecv, this.lastFrom, this.repairUntil, this.lastReplay] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key)
    }
    this.newestCapture.delete(channel >>> 0)
  }

  /** Replays the cached GOP once the link to `child` is open. */
  private replayTo(key: string, child: string, attempt = 0): void {
    const link = this.linkFor(child)
    if (!link || !link.isOpen) {
      if (attempt < 60 && this.children.get(key)?.has(child)) {
        after(200, () => this.replayTo(key, child, attempt + 1))
      }
      return
    }
    // A new attachment always gets the replay; it also counts against the child's next `need-gop`.
    this.noteReplay(key, child)
    this.sendCache(key, link)
  }

  private sendCache(key: string, link: MediaLink): void {
    const cache = this.caches.get(key)
    if (!cache) return
    // Only what the decoder needs to catch up: the keyframe and base-layer frames. Enhancement
    // layers (T1, T2) are referenced by nothing later, and skipping them makes the catch-up about a
    // quarter of the size, which matters with long GOPs.
    for (const raw of cache.frags) if (peekLayer(raw) === 0) this.uplink.send(link, withReplayFlag(raw), 0, REPLAY_MAX_AGE_MS, true)
  }

  /** Fragment produced locally (publisher). */
  inject(raw: Uint8Array): void {
    const frag = decodeFragment(raw)
    if (frag) this.handle(frag, 'self')
  }

  /** Fragment received from a parent. */
  receive(raw: Uint8Array, from: string): void {
    const frag = decodeFragment(raw)
    const verifier = this.verifier
    // Skip verifying duplicates, except a replay we asked for (see expectReplay). Only verified
    // fragments are marked seen, so a forgery can't shadow the genuine fragment with the same id.
    if (!frag || !verifier || (this.seen.has(fragId(frag.header)) && !this.repairing(frag.header))) return
    const h = frag.header
    const ch = h.channel >>> 0
    void verifier(raw, ch).then((ok) => {
      // Signed fragments older than the de-dup window can't be told apart from a resent one, so
      // they are rejected, except replays from a GOP cache, which are old by nature (a GOP can be
      // longer than the window): those are played and cached but never forwarded, so resending
      // them can't flood the tree.
      const newest = this.newestCapture.get(ch) ?? 0
      const stale = h.captureTime < newest - SEEN_RETAIN_MS
      const tooOld = h.captureTime < newest - REPLAY_MAX_LAG_MS
      if (!ok || (stale && !h.replay) || tooOld) {
        this.rejected++
        return
      }
      if (this.seen.has(fragId(h))) {
        // An already-seen fragment replayed on request: local playback only.
        if (this.repairing(h)) this.onFragment(frag, from)
        return
      }
      if (stale) {
        this.markSeen(fragId(h), performance.now())
        if (!h.audio) this.cache(treeKey(h.channel, h.stripe), h.epoch, h.gopId, frag.raw)
        this.onFragment(frag, from)
        return
      }
      this.newestCapture.set(ch, Math.max(newest, h.captureTime))
      this.handle(frag, from)
    })
  }

  private markSeen(id: string, now: number): void {
    this.seen.set(id, now)
    if (now - this.lastSeenPrune > 1000) {
      this.lastSeenPrune = now
      for (const [k, t] of this.seen) if (now - t > SEEN_RETAIN_MS) this.seen.delete(k)
    }
  }

  private handle(frag: Fragment, from: string): void {
    const h = frag.header
    const now = performance.now()
    const id = fragId(h)
    if (this.seen.has(id)) return
    this.markSeen(id, now)

    const key = treeKey(h.channel, h.stripe)
    this.lastRecv.set(key, now)
    this.lastFrom.set(key, from)

    const kids = this.children.get(key)
    if (kids?.size) {
      const layer = peekLayer(frag.raw)
      const maxAge = h.key ? KEY_MAX_AGE_MS : undefined
      // Pieces of one frame on one stripe: if any fragment misses its deadline, the rest go too.
      const frame = h.fragCount > 1 ? `${h.channel >>> 0}:${h.stripe}:${h.epoch}:${h.frameSeq}` : undefined
      for (const child of kids) {
        if (child === from) continue
        const link = this.linkFor(child)
        if (link) this.uplink.send(link, frag.raw, layer, maxAge, false, frame)
      }
    }

    if (!h.audio) this.cache(key, h.epoch, h.gopId, frag.raw)
    this.onFragment(frag, from)
  }

  private cache(key: string, epoch: number, gopId: number, raw: Uint8Array): void {
    let c = this.caches.get(key)
    const startsGop = peekIsKey(raw)
    // Only a newer GOP replaces the cache: an older keyframe can still arrive late (unordered
    // channel, async verification) and must not evict the current GOP.
    if (!c || (startsGop && gopNewer(epoch, gopId, c))) {
      if (!startsGop && !c) return // wait for a keyframe to start caching
      c = { gopId, epoch, frags: [], bytes: 0 }
      this.caches.set(key, c)
    }
    if (gopId !== c.gopId || epoch !== c.epoch) return // stale fragment from an older GOP
    if (c.bytes + raw.byteLength > MAX_CACHE_BYTES) return
    c.frags.push(raw)
    c.bytes += raw.byteLength
  }
}
