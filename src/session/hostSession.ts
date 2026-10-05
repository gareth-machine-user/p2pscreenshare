import { joinStream, randomPeerId, type ControlChannel } from '../net/bootstrap'
import { LinkManager } from '../net/linkManager'
import { Uplink } from '../net/uplink'
import { AudioPipeline } from '../media/audio'
import { captureScreen, testPattern } from '../media/capture'
import { VideoPipeline } from '../media/encoder'
import { packetize, type EncodedFrame } from '../media/packetizer'
import { RelayNode } from '../relay/relayNode'
import { emptyTopology, type ParentChange, type PlannerConfig, type PlannerPeer, type PlanResult, type Topology } from '../topology/model'
import { plan } from '../topology/planner'
import type { HostToViewer, StreamConfig, StreamInfo, ViewerStats, ViewerToHost } from '../proto/messages'

export interface HostOptions {
  streamId: string
  trackers?: string[]
  iceServers?: RTCIceServer[]
  k: number
  m: number
  bitrateKbps: number
  hostUploadKbps: number
  source: 'screen' | 'test'
  audio: boolean
  /** Test pattern size, e.g. [1280, 720]. */
  testSize?: [number, number]
}

export interface HostPeer {
  id: string
  name: string
  joinedAt: number
  probeKbps: number | null
  /** Capacity reduction learned from observed uplink drops (kbps), decays over time. */
  observedCapKbps: number | null
  stats: ViewerStats | null
  failures: number
  /** Peers this peer should not be linked to, with expiry time. */
  avoid: Map<string, number>
  lastSeenAt: number
  pinging: boolean
  probe: { firstAt: number; bytes: number } | null
}

const REPLAN_INTERVAL_MS = 2000
const REMOVAL_TIMEOUT_MS = 4000
const LINK_FAILED_AVOID_MS = 60_000
const SILENT_PARENT_AVOID_MS = 15_000
/** Heartbeat: ping peers we haven't heard from for this long... */
const HEARTBEAT_IDLE_MS = 1000
/** ...and drop them if the pong doesn't arrive within this time. */
const HEARTBEAT_TIMEOUT_MS = 1500
/**
 * After a relay fails, its whole subtree goes silent on that stripe. Descendants' reattach requests
 * within this window blame the upstream failure, not their (healthy) parent.
 */
const UPSTREAM_DISRUPTION_MS = 6000
/**
 * When a relay dies its whole subtree notices at about the same time. Reattach requests are
 * collected for this long and handled shallowest-first, so only the topmost complaint blames a
 * parent and the rest are recognized as collateral.
 */
const REATTACH_BATCH_MS = 400
/** A parent that children report as silent must answer a control-channel ping within this time. */
const LIVENESS_TIMEOUT_MS = 1200

export class HostSession {
  readonly selfId: string
  readonly peers = new Map<string, HostPeer>()
  topology: Topology = emptyTopology()
  lastPlan: PlanResult | null = null
  stream: StreamInfo | null = null
  localStream: MediaStream | null = null
  readonly uplink = new Uplink(null)
  readonly links: LinkManager
  readonly relay: RelayNode
  readonly config: StreamConfig
  totalChanges = 0
  onChange: () => void = () => {}

  private ctl: ControlChannel<ViewerToHost, HostToViewer> | null = null
  trackersConnected = 0
  private video: VideoPipeline | null = null
  private audio: AudioPipeline | null = null
  private stopSource: (() => void) | null = null
  private pendingRemovals = new Map<string, { oldParent: string; timer: ReturnType<typeof setTimeout> }>()
  private replanTimer: ReturnType<typeof setTimeout> | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private lastKeyRequest = 0
  private lastPositions = new Map<string, string>()
  /** `${peer}:${stripe}` -> until when that peer's feed is known to be broken upstream. */
  private disruptedUntil = new Map<string, number>()
  private reattachQueue: { child: string; stripe: number; linkOpen: boolean }[] = []
  private reattachTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: HostOptions) {
    this.config = { k: opts.k, m: opts.m, bitrateKbps: opts.bitrateKbps }
    this.selfId = randomPeerId()
    this.links = new LinkManager(this.selfId, (to, signal) => this.send(to, { t: 'signal', from: this.selfId, signal }), {
      iceServers: opts.iceServers,
    })
    this.links.onBufferLow = () => this.uplink.kick()
    this.links.onLinkState = (remote, state) => {
      if (state === 'failed') this.onLinkFailed(this.selfId, remote)
    }
    this.relay = new RelayNode(this.uplink, (id) => this.links.get(id))

    void joinStream<ViewerToHost, HostToViewer>({
      streamId: opts.streamId,
      role: 'host',
      trackers: opts.trackers,
      iceServers: opts.iceServers,
      peerId: this.selfId,
    }).then((ctl) => {
      this.ctl = ctl
      ctl.onPeerJoin = (id) => this.onPeerJoin(id)
      ctl.onPeerLeave = (id) => this.onPeerLeave(id)
      ctl.onMessage = (msg, from) => this.handle(msg, from)
      ctl.onBinary = (data, from) => this.onProbeChunk(data, from)
      ctl.onTrackerStatus = (c) => {
        this.trackersConnected = c
        this.onChange()
      }
    })

    this.timers.push(setInterval(() => this.replan(), REPLAN_INTERVAL_MS))
    this.timers.push(setInterval(() => this.links.setNeeded(this.relay.allChildren()), 1000))
    this.timers.push(setInterval(() => this.heartbeat(), 250))
  }

  get stripes(): number {
    return this.opts.k + this.opts.m
  }

  get plannerConfig(): PlannerConfig {
    return {
      hostId: this.selfId,
      k: this.opts.k,
      m: this.opts.m,
      // Stripe = 1/k of the video plus the (duplicated) audio and framing overhead.
      stripeKbps: (this.opts.bitrateKbps / this.opts.k) * 1.05 + (this.opts.audio ? 70 : 0),
      hostUploadKbps: this.opts.hostUploadKbps,
      headroom: 0.75,
      maxFanout: 16,
      minUptimeMsForRelay: 4000,
      switchGain: 1,
    }
  }

  async start(): Promise<void> {
    let stream: MediaStream
    if (this.opts.source === 'test') {
      const tp = testPattern(...(this.opts.testSize ?? [1280, 720]))
      stream = tp.stream
      this.stopSource = tp.stop
    } else {
      stream = await captureScreen(this.opts.audio)
      this.stopSource = () => stream.getTracks().forEach((t) => t.stop())
    }
    this.localStream = stream
    const vt = stream.getVideoTracks()[0]
    this.video = new VideoPipeline(vt, { bitrateKbps: this.opts.bitrateKbps, fps: 30, keyframeIntervalMs: 2000 })
    this.video.onFrame = (f) => this.emit(f)
    this.video.onStreamInfo = (info) => this.setStream(info)
    void this.video.start()

    const at = stream.getAudioTracks()[0]
    if (at && this.opts.audio && AudioPipeline.supported()) {
      this.audio = new AudioPipeline(at)
      this.audio.onFrame = (f) => this.emit(f)
      this.audio.start().catch((e) => console.warn('audio disabled', e))
    }
    this.onChange()
  }

  private setStream(info: StreamInfo): void {
    this.stream = { ...info, audio: this.audio?.info ?? undefined }
    for (const id of this.peers.keys()) this.send(id, { t: 'stream', stream: this.stream })
    this.onChange()
  }

  private emit(frame: EncodedFrame): void {
    if (frame.audio && this.stream && !this.stream.audio && this.audio?.info) this.setStream(this.stream)
    for (const frags of packetize(frame, this.opts.k, this.opts.m)) for (const raw of frags) this.relay.inject(raw)
  }

  private send(to: string, msg: HostToViewer): void {
    this.ctl?.send(msg, to)
  }

  // --- membership -------------------------------------------------------------------------------

  private onPeerJoin(id: string): void {
    if (!this.peers.has(id)) {
      this.peers.set(id, {
        id,
        name: id.slice(0, 6),
        joinedAt: performance.now(),
        probeKbps: null,
        observedCapKbps: null,
        stats: null,
        failures: 0,
        avoid: new Map(),
        lastSeenAt: performance.now(),
        pinging: false,
        probe: null,
      })
    }
    this.send(id, { t: 'welcome', config: this.config, stream: this.stream })
    this.scheduleReplan()
    this.onChange()
  }

  private onPeerLeave(id: string): void {
    if (!this.peers.delete(id)) return
    this.relay.removePeer(id)
    this.lastPositions.delete(id)
    // Stop the departed peer's parents from pushing stripes into a dead link (WebRTC may take
    // tens of seconds to notice), including parents that were still being phased out.
    const parents = this.topology.parents[id] ?? []
    parents.forEach((parent, stripe) => {
      if (parent) this.removeEdge(parent, id, stripe)
      // Its subtree is about to go silent; that's not their parents' fault.
      this.markSubtreeDisrupted(id, stripe)
    })
    for (const [key, pr] of this.pendingRemovals) {
      const [child, stripe] = key.split(':')
      if (child === id || pr.oldParent === id) {
        clearTimeout(pr.timer)
        this.pendingRemovals.delete(key)
        if (child === id) this.removeEdge(pr.oldParent, id, Number(stripe))
      }
    }
    this.scheduleReplan(0)
    this.onChange()
  }

  private queueReattach(child: string, stripe: number, linkOpen: boolean): void {
    this.reattachQueue.push({ child, stripe, linkOpen })
    if (this.reattachTimer === null) {
      this.reattachTimer = setTimeout(() => this.processReattaches(), REATTACH_BATCH_MS)
    }
  }

  private processReattaches(): void {
    this.reattachTimer = null
    const batch = this.reattachQueue.splice(0)
    const depth = (r: { child: string; stripe: number }) => this.lastPlan?.depth[r.child]?.[r.stripe] ?? 0
    batch.sort((a, b) => depth(a) - depth(b))
    const now = performance.now()
    let changed = false
    const suspects = new Set<string>()
    for (const { child, stripe, linkOpen } of batch) {
      const peer = this.peers.get(child)
      if (!peer) continue
      const parent = this.topology.parents[child]?.[stripe]
      // The parent is itself starved by an upstream failure that is already being handled:
      // keep this child where it is (the parent's feed will resume).
      if (linkOpen && parent && this.isDisrupted(parent, stripe)) continue
      // This child's feed is broken, and everything below it is going silent as well.
      this.markSubtreeDisrupted(child, stripe, true)
      if (parent && parent !== this.selfId) {
        // Link up but nothing forwarded: the parent is unreliable (rank it lower).
        // Link never came up: this pair can't connect (avoid it for longer).
        // Either way, pick a different parent for this stripe.
        const pp = this.peers.get(parent)
        if (linkOpen && pp) {
          pp.failures++
          suspects.add(parent)
        }
        peer.avoid.set(parent, now + (linkOpen ? SILENT_PARENT_AVOID_MS : LINK_FAILED_AVOID_MS))
      }
      changed = true
    }
    if (changed) this.scheduleReplan(0)
    for (const p of suspects) void this.checkAlive(p)
  }

  /**
   * A vanished peer's connections can look open for many seconds. When children report a silent
   * parent, ping it; no answer means it's gone, which frees its slots for the replan right away.
   */
  private async checkAlive(id: string): Promise<void> {
    try {
      await this.ctl?.requestClock(id, LIVENESS_TIMEOUT_MS)
    } catch {
      if (!this.peers.has(id)) return
      this.ctl?.disconnect(id)
      this.onPeerLeave(id)
    }
  }

  private markSubtreeDisrupted(root: string, stripe: number, includeRoot = false): void {
    const kids = new Map<string, string[]>()
    for (const [peer, ps] of Object.entries(this.topology.parents)) {
      const par = ps[stripe]
      if (par) kids.set(par, [...(kids.get(par) ?? []), peer])
    }
    const until = performance.now() + UPSTREAM_DISRUPTION_MS
    const stack = includeRoot ? [root] : [...(kids.get(root) ?? [])]
    const seen = new Set<string>()
    while (stack.length) {
      const n = stack.pop()!
      if (seen.has(n)) continue
      seen.add(n)
      const key = `${n}:${stripe}`
      this.disruptedUntil.set(key, Math.max(this.disruptedUntil.get(key) ?? 0, until))
      stack.push(...(kids.get(n) ?? []))
    }
  }

  private isDisrupted(peer: string, stripe: number): boolean {
    const key = `${peer}:${stripe}`
    const until = this.disruptedUntil.get(key)
    if (until === undefined) return false
    if (performance.now() < until) return true
    this.disruptedUntil.delete(key)
    return false
  }

  /**
   * WebRTC can take ~30s to declare a vanished peer dead. Ping idle peers over the control channel
   * instead: pongs are answered from a message handler, so background-tab timer throttling on the
   * viewer side doesn't cause false positives.
   */
  private heartbeat(): void {
    const now = performance.now()
    for (const p of this.peers.values()) {
      if (p.pinging || now - p.lastSeenAt < HEARTBEAT_IDLE_MS) continue
      p.pinging = true
      this.ctl
        ?.requestClock(p.id, HEARTBEAT_TIMEOUT_MS)
        .then(() => {
          p.lastSeenAt = performance.now()
        })
        .catch(() => {
          if (!this.peers.has(p.id) || performance.now() - p.lastSeenAt < HEARTBEAT_IDLE_MS + HEARTBEAT_TIMEOUT_MS) return
          this.ctl?.disconnect(p.id)
          this.onPeerLeave(p.id)
        })
        .finally(() => {
          p.pinging = false
        })
    }
  }

  // --- control messages -------------------------------------------------------------------------

  private handle(msg: ViewerToHost, from: string): void {
    const peer = this.peers.get(from)
    if (!peer) return
    peer.lastSeenAt = performance.now()
    switch (msg.t) {
      case 'hello':
        peer.name = msg.name || peer.name
        break
      case 'stats':
        peer.stats = msg.stats
        this.updateObservedCapacity(peer, msg.stats)
        break
      case 'signal':
        if (msg.to === this.selfId) this.links.handleSignal(from, msg.signal)
        else if (this.peers.has(msg.to)) this.send(msg.to, { t: 'signal', from, signal: msg.signal })
        return
      case 'stripe-ok':
        this.completeRemoval(from, msg.stripe, msg.parent)
        return
      case 'link-failed':
        this.onLinkFailed(from, msg.remote)
        break
      case 'reattach':
        this.queueReattach(from, msg.stripe, msg.linkOpen)
        return
      case 'need-key': {
        const now = performance.now()
        if (now - this.lastKeyRequest > 300) {
          this.lastKeyRequest = now
          this.video?.requestKeyframe()
        }
        return
      }
      case 'probe-start':
        peer.probe = null
        return
    }
    this.onChange()
  }

  private onProbeChunk(data: Uint8Array, from: string): void {
    const peer = this.peers.get(from)
    if (!peer || data.byteLength < 5) return
    const now = performance.now()
    if (!peer.probe) {
      peer.probe = { firstAt: now, bytes: 0 }
    } else {
      peer.probe.bytes += data.byteLength
    }
    if (data[4] === 1) {
      const dt = now - peer.probe.firstAt
      if (dt > 50) {
        peer.probeKbps = (peer.probe.bytes * 8) / dt // bits per ms == kbps
        this.send(from, { t: 'probe-result', kbps: peer.probeKbps })
        this.scheduleReplan()
      }
      peer.probe = null
      this.onChange()
    }
  }

  /** Learns from relays that drop packets: their real capacity is below the probe estimate. */
  private updateObservedCapacity(peer: HostPeer, s: ViewerStats): void {
    if (s.uplinkDropRate > 0.03 && s.uplinkKbps > 0) {
      const cap = s.uplinkKbps * 0.9
      peer.observedCapKbps = peer.observedCapKbps === null ? cap : Math.min(peer.observedCapKbps, cap)
    } else if (peer.observedCapKbps !== null) {
      peer.observedCapKbps *= 1.05 // slowly forgive
      if (peer.probeKbps !== null && peer.observedCapKbps > peer.probeKbps) peer.observedCapKbps = null
    }
  }

  private onLinkFailed(a: string, b: string): void {
    const now = performance.now()
    this.peers.get(a)?.avoid.set(b, now + LINK_FAILED_AVOID_MS)
    this.peers.get(b)?.avoid.set(a, now + LINK_FAILED_AVOID_MS)
    this.scheduleReplan(0)
  }

  // --- planning ---------------------------------------------------------------------------------

  private scheduleReplan(delay = 50): void {
    if (this.replanTimer !== null) return
    this.replanTimer = setTimeout(() => {
      this.replanTimer = null
      this.replan()
    }, delay)
  }

  capacityOf(p: HostPeer): number | null {
    if (p.probeKbps === null) return null
    return p.observedCapKbps === null ? p.probeKbps : Math.min(p.probeKbps, p.observedCapKbps)
  }

  replan(): void {
    const now = performance.now()
    for (const [key, until] of this.disruptedUntil) if (now > until) this.disruptedUntil.delete(key)
    const peers: PlannerPeer[] = []
    for (const p of this.peers.values()) {
      for (const [id, until] of p.avoid) if (now > until) p.avoid.delete(id)
      p.failures *= 0.95
      peers.push({
        id: p.id,
        capacityKbps: this.capacityOf(p),
        joinedAt: p.joinedAt,
        failures: p.failures,
        avoid: [...p.avoid.keys()],
        starved: [...Array(this.stripes).keys()].filter((st) => this.isDisrupted(p.id, st)),
      })
    }
    const result = plan(peers, this.topology, this.plannerConfig, now)
    this.lastPlan = result
    this.topology = result.topology
    this.totalChanges += result.changes.length
    for (const c of result.changes) this.apply(c)
    this.links.setNeeded(this.relay.allChildren())
    this.sendPositions(result)
    this.onChange()
  }

  private apply(c: ParentChange): void {
    const key = `${c.peer}:${c.stripe}`
    if (c.to !== null) this.addEdge(c.to, c.peer, c.stripe)
    this.send(c.peer, { t: 'set-parent', stripe: c.stripe, parent: c.to })

    const prev = this.pendingRemovals.get(key)
    if (prev) {
      clearTimeout(prev.timer)
      this.pendingRemovals.delete(key)
      // The older pending parent is superseded too.
      if (prev.oldParent !== c.to) this.removeEdge(prev.oldParent, c.peer, c.stripe)
    }
    if (c.from !== null && (c.from === this.selfId || this.peers.has(c.from))) {
      // Make-before-break: keep the old parent feeding until the new one delivers.
      const oldParent = c.from
      const timer = setTimeout(() => this.completeRemoval(c.peer, c.stripe, null), REMOVAL_TIMEOUT_MS)
      this.pendingRemovals.set(key, { oldParent, timer })
    }
  }

  private completeRemoval(peer: string, stripe: number, deliveredBy: string | null): void {
    const key = `${peer}:${stripe}`
    const pr = this.pendingRemovals.get(key)
    if (!pr) return
    const current = this.topology.parents[peer]?.[stripe]
    if (deliveredBy !== null && deliveredBy !== current) return
    clearTimeout(pr.timer)
    this.pendingRemovals.delete(key)
    if (pr.oldParent !== current) this.removeEdge(pr.oldParent, peer, stripe)
  }

  private addEdge(parent: string, child: string, stripe: number): void {
    if (parent === this.selfId) this.relay.addChild(stripe, child)
    else this.send(parent, { t: 'add-child', stripe, child })
  }

  private removeEdge(parent: string, child: string, stripe: number): void {
    if (parent === this.selfId) this.relay.removeChild(stripe, child)
    else if (this.peers.has(parent)) this.send(parent, { t: 'remove-child', stripe, child })
  }

  private sendPositions(r: PlanResult): void {
    for (const id of this.peers.keys()) {
      const home = r.topology.home[id] ?? null
      const depth = r.depth[id] ?? []
      const sig = `${home}|${depth.join(',')}`
      if (this.lastPositions.get(id) === sig) continue
      this.lastPositions.set(id, sig)
      this.send(id, { t: 'position', home, depth })
    }
  }

  setHostUpload(kbps: number): void {
    this.opts.hostUploadKbps = kbps
    this.scheduleReplan(0)
  }

  get codec(): string | null {
    return this.video?.codec ?? null
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval)
    this.video?.stop()
    this.audio?.stop()
    this.stopSource?.()
    this.links.closeAll()
    await this.ctl?.leave()
  }
}
