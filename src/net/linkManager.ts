import { PeerLink, type LinkSignal, type LinkState } from './link'

const IDLE_CLOSE_MS = 5000

/**
 * Owns one PeerLink per remote peer. The peer with the lexicographically smaller id offers.
 * Links that are no longer needed are closed after a grace period (so a quick re-attach reuses them).
 */
export class LinkManager {
  private links = new Map<string, PeerLink>()
  private idleSince = new Map<string, number>()
  private needed = new Set<string>()

  onData: (remoteId: string, data: Uint8Array) => void = () => {}
  onLinkState: (remoteId: string, state: LinkState) => void = () => {}
  onBufferLow: (link: PeerLink) => void = () => {}

  constructor(
    private selfId: string,
    private sendSignal: (to: string, signal: LinkSignal) => void,
    private rtcConfig: RTCConfiguration,
  ) {}

  get(remoteId: string): PeerLink | undefined {
    return this.links.get(remoteId)
  }

  all(): PeerLink[] {
    return [...this.links.values()]
  }

  /** Returns the link to `remoteId`, creating it if needed. */
  ensure(remoteId: string): PeerLink {
    let link = this.links.get(remoteId)
    if (link && (link.state === 'closed' || link.state === 'failed')) {
      this.links.delete(remoteId)
      link = undefined
    }
    if (!link) link = this.create(remoteId)
    return link
  }

  handleSignal(from: string, signal: LinkSignal): void {
    let link = this.links.get(from)
    // A fresh offer replaces a dead link (e.g. the remote side re-created it).
    if (signal.type === 'sdp' && signal.sdp.type === 'offer' && link && link.state !== 'connecting') {
      link.close()
      link = undefined
    }
    if (!link || link.state === 'closed' || link.state === 'failed') link = this.create(from)
    void link.handleSignal(signal)
  }

  /** Declares which remote peers we currently need links to; others are closed when idle. */
  setNeeded(ids: Iterable<string>): void {
    this.needed = new Set(ids)
    for (const id of this.needed) this.ensure(id)
    const now = performance.now()
    for (const [id, link] of this.links) {
      if (this.needed.has(id)) {
        this.idleSince.delete(id)
        continue
      }
      const since = this.idleSince.get(id) ?? now
      this.idleSince.set(id, since)
      if (now - since > IDLE_CLOSE_MS && now - link.createdAt > IDLE_CLOSE_MS) {
        link.close()
        this.links.delete(id)
        this.idleSince.delete(id)
      }
    }
  }

  closeAll(): void {
    for (const link of this.links.values()) link.close()
    this.links.clear()
  }

  private create(remoteId: string): PeerLink {
    const link = new PeerLink({
      remoteId,
      offerer: this.selfId < remoteId,
      rtcConfig: this.rtcConfig,
      sendSignal: (sig) => this.sendSignal(remoteId, sig),
    })
    link.onMessage = (data) => this.onData(remoteId, data)
    link.onBufferLow = () => this.onBufferLow(link)
    link.onStateChange = (state) => {
      if ((state === 'closed' || state === 'failed') && this.links.get(remoteId) === link) {
        this.links.delete(remoteId)
      }
      this.onLinkState(remoteId, state)
    }
    this.links.set(remoteId, link)
    return link
  }
}
