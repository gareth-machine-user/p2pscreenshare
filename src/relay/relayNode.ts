import { decodeFragment, peekIsKey, peekLayer, withReplayFlag, type Fragment, type FragmentHeader } from '../proto/framing'
import type { PeerLink } from '../net/link'
import type { Uplink } from '../net/uplink'

const SEEN_RETAIN_MS = 5000
const MAX_CACHE_BYTES = 6 * 1024 * 1024
/** Replayed GOP fragments may wait longer in the queue than live ones. */
const REPLAY_MAX_AGE_MS = 2500

interface StripeCache {
  gopId: number
  epoch: number
  frags: Uint8Array[]
  bytes: number
}

const fragId = (h: FragmentHeader) => `${h.audio ? 'a' : 'v'}${h.stripe}:${h.epoch}:${h.frameSeq}:${h.pieceIdx}:${h.fragIdx}`

/**
 * Forwards fragments verbatim to children (cut-through, per stripe), de-duplicates (e.g. while two
 * parents overlap during make-before-break), and keeps a per-stripe cache of the current GOP so a
 * newly attached child can start decoding immediately. Received fragments are only forwarded or
 * played once their host signature verifies.
 */
export class RelayNode {
  private children = new Map<number, Set<string>>()
  private seen = new Map<string, number>()
  private lastSeenPrune = 0
  private caches = new Map<number, StripeCache>()
  /** Local time of the last fragment received per stripe. */
  readonly lastRecv = new Map<number, number>()
  /** Who delivered the last fragment per stripe. */
  readonly lastFrom = new Map<number, string>()

  /** Called for every new (non-duplicate) fragment, for local playback. */
  onFragment: (frag: Fragment, from: string) => void = () => {}
  /** Checks a received fragment's host signature. Unset: nothing received is accepted. */
  verifier: ((raw: Uint8Array) => Promise<boolean>) | null = null
  /** Received fragments dropped for a bad signature or for being stale. */
  rejected = 0
  /** Newest capture time among verified fragments. */
  private newestCapture = 0

  constructor(
    private uplink: Uplink,
    private linkFor: (peerId: string) => PeerLink | undefined,
  ) {}

  childrenOf(stripe: number): string[] {
    return [...(this.children.get(stripe) ?? [])]
  }

  allChildren(): Set<string> {
    const out = new Set<string>()
    for (const set of this.children.values()) for (const c of set) out.add(c)
    return out
  }

  addChild(stripe: number, child: string): void {
    let set = this.children.get(stripe)
    if (!set) {
      set = new Set()
      this.children.set(stripe, set)
    }
    if (set.has(child)) return
    set.add(child)
    this.replayTo(stripe, child)
  }

  removeChild(stripe: number, child: string): void {
    this.children.get(stripe)?.delete(child)
  }

  removePeer(peer: string): void {
    for (const set of this.children.values()) set.delete(peer)
  }

  /** Replays the cached GOP once the link to `child` is open. */
  private replayTo(stripe: number, child: string, attempt = 0): void {
    const link = this.linkFor(child)
    if (!link || !link.isOpen) {
      if (attempt < 60 && this.children.get(stripe)?.has(child)) {
        setTimeout(() => this.replayTo(stripe, child, attempt + 1), 200)
      }
      return
    }
    const cache = this.caches.get(stripe)
    if (!cache) return
    for (const raw of cache.frags) this.uplink.send(link, withReplayFlag(raw), 0, REPLAY_MAX_AGE_MS)
  }

  /** Fragment produced locally (host). */
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
    void verifier(raw).then((ok) => {
      // Signed fragments older than the de-dup window can't be told apart from a replay.
      if (!ok || frag.header.captureTime < this.newestCapture - SEEN_RETAIN_MS) {
        this.rejected++
        return
      }
      this.newestCapture = Math.max(this.newestCapture, frag.header.captureTime)
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

    this.lastRecv.set(h.stripe, now)
    this.lastFrom.set(h.stripe, from)

    // Forward the original bytes (replay flag stripped by sending `raw` only for live fragments).
    const kids = this.children.get(h.stripe)
    if (kids?.size) {
      const layer = peekLayer(frag.raw)
      for (const child of kids) {
        if (child === from) continue
        const link = this.linkFor(child)
        if (link) this.uplink.send(link, frag.raw, layer)
      }
    }

    if (!h.audio) this.cache(h.stripe, h.epoch, h.gopId, frag.raw)
    this.onFragment(frag, from)
  }

  private cache(stripe: number, epoch: number, gopId: number, raw: Uint8Array): void {
    let c = this.caches.get(stripe)
    const startsGop = peekIsKey(raw)
    if (!c || (startsGop && (gopId !== c.gopId || epoch !== c.epoch))) {
      if (!startsGop && !c) return // wait for a keyframe to start caching
      c = { gopId, epoch, frags: [], bytes: 0 }
      this.caches.set(stripe, c)
    }
    if (gopId !== c.gopId || epoch !== c.epoch) return // stale fragment from an older GOP
    if (c.bytes + raw.byteLength > MAX_CACHE_BYTES) return
    c.frags.push(raw)
    c.bytes += raw.byteLength
  }
}
