// Minimal WebTorrent (WebSocket) tracker client, used only as a WebRTC signaling rendezvous.
//
// Protocol: peers "announce" to an info_hash; offers attached to an announce are forwarded by the
// tracker to distinct random peers in the swarm; answers are routed back by offer_id/peer_id.
// Trackers can't target a specific peer, so the swarm is kept small: viewers leave it (event
// "stopped") as soon as they are connected, leaving only the host plus viewers still joining.

export interface TrackerOffer {
  offerId: string
  sdp: string
}

export interface IncomingOffer extends TrackerOffer {
  peerId: string
  /** Sends the answer back through the tracker the offer came from. */
  reply: (sdp: string) => void
}

export interface IncomingAnswer {
  offerId: string
  peerId: string
  sdp: string
}

interface Socket {
  url: string
  ws: WebSocket | null
  retryMs: number
  timer: ReturnType<typeof setTimeout> | null
}

export class TrackerClient {
  onOffer: (o: IncomingOffer) => void = () => {}
  onAnswer: (a: IncomingAnswer) => void = () => {}
  onStatus: (connected: number, total: number) => void = () => {}

  private sockets: Socket[]
  private closed = false
  private lastAnnounce: Record<string, unknown> | null = null

  constructor(
    urls: string[],
    private infoHash: string,
    private peerId: string,
  ) {
    this.sockets = urls.map((url) => ({ url, ws: null, retryMs: 1000, timer: null }))
    this.sockets.forEach((s) => this.connect(s))
  }

  get connectedCount(): number {
    return this.sockets.filter((s) => s.ws?.readyState === WebSocket.OPEN).length
  }

  private connect(s: Socket): void {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(s.url)
    } catch {
      this.scheduleReconnect(s)
      return
    }
    s.ws = ws
    ws.onopen = () => {
      s.retryMs = 1000
      this.onStatus(this.connectedCount, this.sockets.length)
      // Re-send the latest announce so a reconnecting tracker learns about us.
      if (this.lastAnnounce) this.sendTo(s, this.lastAnnounce)
    }
    ws.onclose = () => {
      if (s.ws === ws) s.ws = null
      this.onStatus(this.connectedCount, this.sockets.length)
      this.scheduleReconnect(s)
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (ev) => this.handle(s, ev.data)
  }

  private scheduleReconnect(s: Socket): void {
    if (this.closed || s.timer) return
    s.timer = setTimeout(() => {
      s.timer = null
      this.connect(s)
    }, s.retryMs)
    s.retryMs = Math.min(s.retryMs * 2, 30_000)
  }

  private handle(s: Socket, raw: unknown): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (msg.info_hash !== this.infoHash) return
    if (msg['failure reason']) {
      console.warn(`tracker ${s.url}: ${String(msg['failure reason'])}`)
      return
    }
    const peerId = msg.peer_id as string | undefined
    const offerId = msg.offer_id as string | undefined
    if (!peerId || !offerId || peerId === this.peerId) return
    const offer = msg.offer as { sdp?: string } | undefined
    const answer = msg.answer as { sdp?: string } | undefined
    if (offer?.sdp) {
      this.onOffer({
        offerId,
        peerId,
        sdp: offer.sdp,
        reply: (sdp) =>
          this.sendTo(s, {
            action: 'announce',
            info_hash: this.infoHash,
            peer_id: this.peerId,
            to_peer_id: peerId,
            offer_id: offerId,
            answer: { type: 'answer', sdp },
          }),
      })
    } else if (answer?.sdp) {
      this.onAnswer({ offerId, peerId, sdp: answer.sdp })
    }
  }

  private sendTo(s: Socket, msg: Record<string, unknown>): void {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg))
  }

  announce(opts: { offers?: TrackerOffer[]; event?: 'started' | 'stopped' | 'completed'; numwant?: number }): void {
    const msg: Record<string, unknown> = {
      action: 'announce',
      info_hash: this.infoHash,
      peer_id: this.peerId,
      numwant: opts.numwant ?? opts.offers?.length ?? 0,
      uploaded: 0,
      downloaded: 0,
      left: 1,
      offers: (opts.offers ?? []).map((o) => ({ offer_id: o.offerId, offer: { type: 'offer', sdp: o.sdp } })),
    }
    if (opts.event) msg.event = opts.event
    this.lastAnnounce = opts.event === 'stopped' ? null : { ...msg, event: undefined }
    for (const s of this.sockets) this.sendTo(s, msg)
  }

  close(): void {
    this.closed = true
    for (const s of this.sockets) {
      if (s.timer) clearTimeout(s.timer)
      s.ws?.close()
    }
  }
}

/** 20-character peer ids, as the WebTorrent tracker protocol expects. */
export function randomPeerId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => alphabet[b % alphabet.length]).join('')
}

export const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
]
