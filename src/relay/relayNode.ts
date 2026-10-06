import { decodeFragment, peekIsKey, peekLayer, withReplayFlag, type Fragment, type FragmentHeader } from '../proto/framing'
import type { MediaLink } from '../net/link'
import { after } from '../net/ticker'
import type { Uplink } from '../net/uplink'

const SEEN_RETAIN_MS = 5000
const MAX_CACHE_BYTES = 6 * 1024 * 1024
/** Replayed GOP fragments may wait longer in the queue than live ones. */
const REPLAY_MAX_AGE_MS = 2500
/**
 * Keyframe fragments may wait longer than other base-layer fragments: a late keyframe still unlocks
 * every frame after it, while dropping one leaves an overloaded child unable to decode at all.
 */
const KEY_MAX_AGE_MS = 2000

interface StripeCache {
  gopId: number
  epoch: number
  frags: Uint8Array[]
  bytes: number
}

/** A (channel, stripe) pair: one tree. */
export const treeKey = (channel: number, stripe: number) => `${channel >>> 0}:${stripe}`

const fragId = (h: FragmentHeader) =>
  `${h.channel >>> 0}:${h.audio ? 'a' : 'v'}${h.stripe}:${h.epoch}:${h.frameSeq}:${h.pieceIdx}:${h.fragIdx}`

/**
 * Forwards fragments verbatim to children (cut-through, per channel and stripe), de-duplicates
 * (e.g. while two parents overlap during make-before-break), and keeps a cache of the current GOP
 * per (channel, stripe) so a newly attached child can start decoding immediately. Received
 * fragments are only forwarded or played once the channel publisher's signature verifies.
 */
export class RelayNode {
  private children = new Map<string, Set<string>>()
  private seen = new Map<string, number>()
  private lastSeenPrune = 0
  private caches = new Map<string, StripeCache>()
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
    for (const map of [this.children, this.caches, this.lastRecv, this.lastFrom] as Map<string, unknown>[]) {
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
    const cache = this.caches.get(key)
    if (!cache) return
    for (const raw of cache.frags) this.uplink.send(link, withReplayFlag(raw), 0, REPLAY_MAX_AGE_MS, true)
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
    // Skip verifying duplicates. Only verified fragments are marked seen, so a forgery can't
    // shadow the genuine fragment with the same id.
    if (!frag || !verifier || this.seen.has(fragId(frag.header))) return
    const ch = frag.header.channel >>> 0
    void verifier(raw, ch).then((ok) => {
      // Signed fragments older than the de-dup window can't be told apart from a replay.
      const newest = this.newestCapture.get(ch) ?? 0
      if (!ok || frag.header.captureTime < newest - SEEN_RETAIN_MS) {
        this.rejected++
        return
      }
      this.newestCapture.set(ch, Math.max(newest, frag.header.captureTime))
      this.handle(frag, from)
    })
  }

  private handle(frag: Fragment, from: string): void {
    const h = frag.header
    const now = performance.now()
    const id = fragId(h)
    if (this.seen.has(id)) return
    this.seen.set(id, now)
    if (now - this.lastSeenPrune > 1000) {
      this.lastSeenPrune = now
      for (const [k, t] of this.seen) if (now - t > SEEN_RETAIN_MS) this.seen.delete(k)
    }

    const key = treeKey(h.channel, h.stripe)
    this.lastRecv.set(key, now)
    this.lastFrom.set(key, from)

    const kids = this.children.get(key)
    if (kids?.size) {
      const layer = peekLayer(frag.raw)
      const maxAge = h.key ? KEY_MAX_AGE_MS : undefined
      for (const child of kids) {
        if (child === from) continue
        const link = this.linkFor(child)
        if (link) this.uplink.send(link, frag.raw, layer, maxAge)
      }
    }

    if (!h.audio) this.cache(key, h.epoch, h.gopId, frag.raw)
    this.onFragment(frag, from)
  }

  private cache(key: string, epoch: number, gopId: number, raw: Uint8Array): void {
    let c = this.caches.get(key)
    const startsGop = peekIsKey(raw)
    if (!c || (startsGop && (gopId !== c.gopId || epoch !== c.epoch))) {
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
