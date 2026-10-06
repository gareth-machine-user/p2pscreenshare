import { joinStream, randomPeerId, wallClock, type ControlChannel } from '../net/bootstrap'
import { hostKeyFromCode } from '../net/lobby'
import { LinkManager } from '../net/linkManager'
import { Uplink } from '../net/uplink'
import { Player } from '../media/player'
import { Reassembler } from '../media/reassembler'
import { verifyFragment } from '../proto/signing'
import { RelayNode } from '../relay/relayNode'
import type { HostToViewer, StreamConfig, StreamInfo, ViewerStats, ViewerToHost } from '../proto/messages'

export interface ViewerOptions {
  /** The join code, which pins the host's public key. */
  streamId: string
  name: string
  trackers?: string[]
  iceServers?: RTCIceServer[]
  /** Debug upload cap (kbps) to emulate a constrained peer. */
  capKbps: number | null
}

const STATS_INTERVAL_MS = 2000
const HEALTH_INTERVAL_MS = 250
const STRIPE_SILENCE_MS = 2000
const PARENT_GRACE_MS = 3000
/** Extra time allowed for a link that is still connecting (ICE can be slow). */
const LINK_SETUP_GRACE_MS = 8000
const REATTACH_COOLDOWN_MS = 4000
const PROBE_DURATION_MS = 1500
const PROBE_CHUNK = 16 * 1024

export type ViewerState = 'joining' | 'connected' | 'host-lost' | 'invalid-link'

export class ViewerSession {
  state: ViewerState = 'joining'
  hostId: string | null = null
  config: StreamConfig | null = null
  stream: StreamInfo | null = null
  parents: (string | null)[] = []
  home: number | null = null
  depth: number[] = []
  probeKbps: number | null = null
  /** Last stats report sent to the host (includes link RTTs). */
  lastStats: ViewerStats | null = null
  readonly selfId: string
  readonly player: Player
  readonly uplink: Uplink
  readonly links: LinkManager
  readonly relay: RelayNode
  /** Invoked whenever UI-relevant state changes. */
  onChange: () => void = () => {}

  private ctl: ControlChannel<HostToViewer, ViewerToHost> | null = null
  trackersConnected = 0
  private reassembler: Reassembler
  private pendingOk = new Map<number, string>()
  private parentSetAt = new Map<number, number>()
  private lastReattach = new Map<number, number>()
  private lastKeyRequest = 0
  private timers: ReturnType<typeof setInterval>[] = []
  private lastUplinkSample = { at: performance.now(), sent: 0, sentItems: 0, dropped: 0 }
  private uplinkKbps = 0
  private uplinkDropRate = 0

  constructor(
    private opts: ViewerOptions,
    canvas: HTMLCanvasElement | null,
  ) {
    this.selfId = randomPeerId()
    this.uplink = new Uplink(opts.capKbps)
    this.player = new Player(canvas, () => this.requestKeyframe())
    this.links = new LinkManager(
      this.selfId,
      (to, signal) => this.toHost({ t: 'signal', to, signal }),
      { iceServers: opts.iceServers },
    )
    this.relay = new RelayNode(this.uplink, (id) => this.links.get(id))
    this.reassembler = new Reassembler((f) => this.player.push(f))

    this.links.onData = (from, data) => this.relay.receive(data, from)
    this.links.onBufferLow = () => this.uplink.kick()
    this.links.onLinkState = (remote, state) => {
      if (state === 'failed') this.toHost({ t: 'link-failed', remote })
      this.onChange()
    }
    this.relay.onFragment = (frag, from) => {
      this.reassembler.push(frag, wallClock())
      const s = frag.header.stripe
      if (this.pendingOk.get(s) === from) {
        this.pendingOk.delete(s)
        this.toHost({ t: 'stripe-ok', stripe: s, parent: from })
      }
    }

    void hostKeyFromCode(opts.streamId).then((hostKey) => {
      if (!hostKey) {
        this.state = 'invalid-link'
        this.onChange()
        return
      }
      this.relay.verifier = (raw) => verifyFragment(hostKey, raw)
      return joinStream<HostToViewer, ViewerToHost>({
        streamId: opts.streamId,
        role: 'viewer',
        hostKey,
        trackers: opts.trackers,
        iceServers: opts.iceServers,
        peerId: this.selfId,
      }).then((ctl) => this.attachControl(ctl))
    })

    this.timers.push(setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS))
    this.timers.push(setInterval(() => this.sendStats(), STATS_INTERVAL_MS))
    this.timers.push(setInterval(() => this.syncLinks(), 1000))
    this.timers.push(setInterval(() => void this.syncClock(), 15_000))
  }

  private attachControl(ctl: ControlChannel<HostToViewer, ViewerToHost>): void {
    this.ctl = ctl
    ctl.onMessage = (msg, from) => this.handle(msg, from)
    ctl.onPeerLeave = (id) => {
      if (id === this.hostId) {
        this.state = 'host-lost'
        this.onChange()
      }
    }
    ctl.onTrackerStatus = (c) => {
      this.trackersConnected = c
      this.onChange()
    }
  }

  private toHost(msg: ViewerToHost): void {
    if (this.hostId) this.ctl?.send(msg, this.hostId)
  }

  private handle(msg: HostToViewer, from: string): void {
    if (msg.t === 'welcome') {
      if (this.hostId && this.hostId !== from && this.state === 'connected') return
      this.hostId = from
      this.state = 'connected'
      this.config = msg.config
      this.parents = new Array(msg.config.k + msg.config.m).fill(null)
      if (msg.stream) this.setStream(msg.stream)
      this.toHost({ t: 'hello', name: this.opts.name, capKbps: this.opts.capKbps })
      void this.syncClock()
      setTimeout(() => void this.probe(), 300)
      this.onChange()
      return
    }
    if (from !== this.hostId) return
    switch (msg.t) {
      case 'stream':
        this.setStream(msg.stream)
        break
      case 'set-parent':
        this.parents[msg.stripe] = msg.parent
        this.parentSetAt.set(msg.stripe, performance.now())
        if (msg.parent) this.pendingOk.set(msg.stripe, msg.parent)
        this.syncLinks()
        break
      case 'add-child':
        this.relay.addChild(msg.stripe, msg.child)
        this.syncLinks()
        break
      case 'remove-child':
        this.relay.removeChild(msg.stripe, msg.child)
        this.syncLinks()
        break
      case 'signal':
        this.links.handleSignal(msg.from, msg.signal)
        break
      case 'probe-result':
        this.probeKbps = msg.kbps
        break
      case 'position':
        this.home = msg.home
        this.depth = msg.depth
        break
    }
    this.onChange()
  }

  private setStream(info: StreamInfo): void {
    this.stream = info
    this.player.setStreamInfo(info)
  }

  private syncLinks(): void {
    const needed = new Set<string>(this.relay.allChildren())
    for (const p of this.parents) if (p) needed.add(p)
    this.links.setNeeded(needed)
  }

  private requestKeyframe(): void {
    const now = performance.now()
    if (now - this.lastKeyRequest < 500) return
    this.lastKeyRequest = now
    this.toHost({ t: 'need-key' })
  }

  /** Detects silent stripes (dead or stalled parent) and asks the host for a new parent. */
  private checkHealth(): void {
    if (this.state !== 'connected') return
    const now = performance.now()
    this.parents.forEach((parent, s) => {
      if (!parent) return
      const setAt = this.parentSetAt.get(s) ?? 0
      const link = this.links.get(parent)
      const linkOpen = !!link?.isOpen
      if (now - setAt < (linkOpen || link?.state === 'failed' ? PARENT_GRACE_MS : LINK_SETUP_GRACE_MS)) return
      const last = this.relay.lastRecv.get(s)
      if (last !== undefined && now - last < STRIPE_SILENCE_MS) return
      if (now - (this.lastReattach.get(s) ?? 0) < REATTACH_COOLDOWN_MS) return
      this.lastReattach.set(s, now)
      this.toHost({ t: 'reattach', stripe: s, linkOpen })
    })
  }

  private async syncClock(): Promise<void> {
    if (!this.hostId) return
    let best: { rtt: number; offset: number } | null = null
    for (let i = 0; i < 5; i++) {
      try {
        const t0 = wallClock()
        const remote = await this.ctl!.requestClock(this.hostId)
        const t1 = wallClock()
        const rtt = t1 - t0
        if (!best || rtt < best.rtt) best = { rtt, offset: remote - (t0 + t1) / 2 }
      } catch {
        // ignore
      }
    }
    if (best) this.player.clockOffset = best.offset
  }

  /** Measures upload throughput by streaming data to the host for ~1.5s (paced by the debug cap). */
  async probe(): Promise<void> {
    if (!this.hostId) return
    const host = this.hostId
    const start = performance.now()
    let seq = 0
    this.toHost({ t: 'probe-start', bytes: 0 })
    for (;;) {
      const last = performance.now() - start >= PROBE_DURATION_MS
      const chunk = new Uint8Array(PROBE_CHUNK)
      new DataView(chunk.buffer).setUint32(0, seq++, true)
      chunk[4] = last ? 1 : 0
      await this.uplink.paced(chunk.byteLength)
      try {
        await this.ctl!.sendBinary(chunk, host)
      } catch {
        return
      }
      if (last) break
    }
  }

  private sampleUplink(): void {
    const now = performance.now()
    const s = this.uplink.stats
    const dt = (now - this.lastUplinkSample.at) / 1000
    if (dt <= 0) return
    const sent = s.sentBytes - this.lastUplinkSample.sent
    const items = s.sentItems - this.lastUplinkSample.sentItems
    const dropped = s.droppedItems - this.lastUplinkSample.dropped
    this.uplinkKbps = (sent * 8) / 1000 / dt
    this.uplinkDropRate = items + dropped > 0 ? dropped / (items + dropped) : 0
    this.lastUplinkSample = { at: now, sent: s.sentBytes, sentItems: s.sentItems, dropped: s.droppedItems }
  }

  get stats(): ViewerStats {
    const now = performance.now()
    const p = this.player.stats
    return {
      probeKbps: this.probeKbps,
      capKbps: this.opts.capKbps,
      uplinkKbps: this.uplinkKbps,
      uplinkDropRate: this.uplinkDropRate,
      stripes: this.parents.map((parent, s) => {
        const last = this.relay.lastRecv.get(s)
        return { parent, lastRecvAgoMs: last === undefined ? null : now - last, rttMs: null }
      }),
      children: this.relay.allChildren().size,
      latencyMs: p.latencyMs,
      bufferMs: p.bufferMs,
      fps: p.fps,
      decodedFrames: p.decodedFrames,
      droppedFrames: p.droppedFrames,
      waitingForKeyframe: p.waitingForKeyframe,
    }
  }

  private async sendStats(): Promise<void> {
    if (this.state !== 'connected') return
    this.sampleUplink()
    const stats = this.stats
    await Promise.all(
      stats.stripes.map(async (st) => {
        if (st.parent) st.rttMs = (await this.links.get(st.parent)?.rttMs()) ?? null
      }),
    )
    this.lastStats = stats
    this.toHost({ t: 'stats', stats })
    this.onChange()
  }

  async leave(): Promise<void> {
    this.timers.forEach(clearInterval)
    this.links.closeAll()
    this.player.close()
    await this.ctl?.leave()
  }
}
