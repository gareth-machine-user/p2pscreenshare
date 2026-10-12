// The media path of a mesh connection: fragments ride inside the encoded frames of a dummy 16×16
// VP8 "carrier" video track, so they get the browser's RTP congestion control (GCC), NACK/RTX
// recovery and pacing.
//
// Why not a data channel: every SCTP association recovers from a loss with Reno, at one packet per
// round trip, so on a long path with a little loss it carries a fraction of the path (0.45 Mbps at
// 300 ms and 0.5% loss, measured with e2e/diag-sctp.spec.ts), and browsers give data no other
// transport. The same path carried 15.7 Mbps as carrier frames (e2e/diag-rtp.spec.ts).
//
// The carrier transceiver (sendrecv) is added before the connection's offer or answer is made, so
// it is in the first SDP, a door's pooled offers included (it doesn't depend on who answers), and
// never needs renegotiating; ICE and DTLS are the connection's own (BUNDLE). A worker per open
// connection (carrierWorker.ts) owns the encoded transforms: it packs what send() hands it into
// carrier frames (net/carrier.ts) at most as fast as the browser's estimate allows, and hands the
// decoder each received frame's original bytes back.
//
// For the uplink (net/uplink.ts) it is a MediaLink like a data channel was: bufferedAmount is what
// was handed over and not yet packed (up to bufferHigh), and onBufferLow fires as it falls. The
// probe link is padding: probe bytes go into carrier frames after the media, within the same
// budget, so a headroom probe (session/headroom.ts) makes the estimate grow on a stream that sends
// less than it (GCC only grows what is used). The receiver drops the padding.
//
// The browser's estimate (getStats availableOutgoingBitrate), capped for the round trip, is the
// send rate, and, through session/connMetrics.ts, the connection's capacity.
import { BACKGROUND_BUFFER_MAX, LINK_BUFFER_HIGH, LINK_BUFFER_LOW, type LinkState, type ProbeLink } from '../net/link'
import { MAX_CARRIER_MESSAGE } from '../net/carrier'
import { parseLinkStats, type StatsLike } from '../net/linkStats'
import { every } from '../net/ticker'

/** Most a connection sends (kbps), whatever the browser estimates: on a short path. */
export const CARRIER_MAX_KBPS = 50_000
/**
 * On a long path, at most this much in flight (kbit: rate × round trip). One carrier collapsed once
 * its estimate reached a bottleneck at ~4300 packets/s (~40 Mbps, 300 ms round trip): the
 * receiver's packet buffer overflowed, hundreds of keyframe requests followed and the estimate
 * crashed. This allows 20 Mbps there.
 */
export const CARRIER_INFLIGHT_KBIT = 6000
/** The cap until the round trip is known (kbps)... */
export const CARRIER_UNKNOWN_RTT_KBPS = 20_000
/** ...and the least it gets on the longest paths. */
export const CARRIER_MIN_CAP_KBPS = 8000

/**
 * The most a connection sends (kbps) for its round trip (ms, the lowest seen): a short path's
 * capped at CARRIER_MAX_KBPS (a localhost or LAN stream isn't held to a long path's limit, which
 * a sharp screen at 60 fps with parity outgrows), a long one by CARRIER_INFLIGHT_KBIT.
 */
export function carrierCapKbps(rttMs: number | null): number {
  if (rttMs === null || !(rttMs >= 0)) return CARRIER_UNKNOWN_RTT_KBPS
  const cap = (CARRIER_INFLIGHT_KBIT * 1000) / Math.max(rttMs, 1)
  return Math.round(Math.min(CARRIER_MAX_KBPS, Math.max(CARRIER_MIN_CAP_KBPS, cap)))
}
/** Carrier frames per second while there is something to send: each carries what the budget allows. */
export const CARRIER_FPS = 100
/** ...and once nothing has been for CARRIER_IDLE_MS: a keepalive (a lobby has many idle pairs). */
export const CARRIER_IDLE_FPS = 5
export const CARRIER_IDLE_MS = 2000
/**
 * The bandwidth estimate a connection starts from (kbps), written into the SDP the browser reads it
 * from (`x-google-start-bitrate`; Chromium starts at 300 kbps otherwise). Also the send rate until
 * the first estimate is read.
 */
export const CARRIER_START_KBPS = 2500
/**
 * How much sending time the uplink may hand the carrier at once (ms of its send rate; at least
 * LINK_BUFFER_HIGH). A carrier frame takes one stripe of a media frame at most (net/carrier.ts), so
 * with only one media frame waiting it carries one stripe per frame interval, whatever the
 * estimate: ~15 KiB per 10 ms caps it near 12-20 Mbps. Twice a 4+2 frame's six carrier frames
 * keeps enough media frames waiting.
 */
export const CARRIER_BUFFER_MS = 120
/** How often the estimate is read while the carrier is busy, and the worker's clock checked (ms). */
const ESTIMATE_POLL_MS = 1000
/** The worker has hung if its clock hasn't ticked for this long (ms; it ticks at least every 200). */
export const CARRIER_HUNG_MS = 2000
/** The carrier track's frame size (px): as small as the encoder takes. */
const CARRIER_SIZE = 16

/**
 * The carrier's send buffer as the uplink sees it: bytes handed over and not yet packed, its
 * watermarks (which move with the send rate), and when to wake the uplink (onBufferLow).
 */
export class CarrierBuffer {
  handed = 0
  packed = 0
  /** The send rate (kbps), which sets the watermarks. */
  rateKbps = CARRIER_START_KBPS

  /** Bytes handed over and not yet packed into a carrier frame. */
  get amount(): number {
    return this.handed - this.packed
  }

  /** How much the uplink may hand over at once (see CARRIER_BUFFER_MS). */
  get high(): number {
    return Math.max(LINK_BUFFER_HIGH, Math.round((this.rateKbps / 8) * CARRIER_BUFFER_MS))
  }

  /** The uplink is woken as the buffer falls to this. */
  get low(): number {
    return Math.max(LINK_BUFFER_LOW, Math.round(this.high / 4))
  }

  /**
   * `bytes` were packed: whether that should wake the uplink. It falls through the low mark, or
   * through BACKGROUND_BUFFER_MAX (a fast carrier's low mark is above it): GOP-cache replays and
   * probes wait for that one, and with no live media to send nothing else would wake them.
   */
  pack(bytes: number): boolean {
    const before = this.amount
    this.packed += bytes
    const after = this.amount
    const low = this.low
    return (before > low && after <= low) || (low > BACKGROUND_BUFFER_MAX && before > BACKGROUND_BUFFER_MAX && after <= BACKGROUND_BUFFER_MAX)
  }

  /**
   * A new send rate: whether it should wake the uplink. A higher rate raises the high mark, and an
   * uplink waiting under the old one sees no fall through a mark (the low one moved up past it).
   */
  setRate(kbps: number): boolean {
    const high = this.high
    this.rateKbps = kbps
    return this.high > high && this.amount <= this.high
  }
}

/**
 * Whether the carrier worker's clock has stopped (the worker hung): no tick for CARRIER_HUNG_MS,
 * checked every ESTIMATE_POLL_MS. Not if the page itself stalled since the last check: its own
 * queued ticks may not have been handled yet.
 */
export class TickWatch {
  private lastTickAt: number
  private lastCheckAt: number

  constructor(now: number) {
    this.lastTickAt = this.lastCheckAt = now
  }

  tick(now: number): void {
    this.lastTickAt = now
  }

  hung(now: number): boolean {
    const pageRan = now - this.lastCheckAt < ESTIMATE_POLL_MS * 1.5
    this.lastCheckAt = now
    return pageRan && now - this.lastTickAt > CARRIER_HUNG_MS
  }
}

type TransformApi = 'script' | 'legacy'

/** The minimal MediaStreamTrackGenerator (Chromium, main thread) the carrier track uses. */
interface TrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<VideoFrame>
}
declare const MediaStreamTrackGenerator: { new (init: { kind: 'video' }): TrackGenerator } | undefined

/**
 * Which encoded-transform API to use. Chromium's createEncodedStreams() first: its
 * RTCRtpScriptTransform runs only one of a connection's two transforms (whichever is set first gets
 * frames, the other none, measured on Chromium 150 with a sendrecv carrier).
 */
function transformApi(): TransformApi | null {
  const sender = typeof RTCRtpSender === 'function' ? (RTCRtpSender.prototype as unknown as Record<string, unknown>) : null
  if (typeof sender?.createEncodedStreams === 'function') return 'legacy'
  return typeof RTCRtpScriptTransform === 'function' ? 'script' : null
}

function hasGenerator(): boolean {
  return typeof MediaStreamTrackGenerator === 'function' && typeof VideoFrame === 'function'
}

/**
 * What this browser lacks for the carrier, or null if it has everything: encoded transforms, a
 * frame source (MediaStreamTrackGenerator, else a canvas's captureStream) and VP8.
 */
export function carrierUnsupported(): string | null {
  try {
    if (typeof RTCPeerConnection !== 'function') return 'WebRTC'
    if (typeof Worker !== 'function') return 'Web Workers'
    if (!transformApi()) return 'WebRTC encoded transforms'
    if (!hasGenerator() && (typeof HTMLCanvasElement?.prototype.captureStream !== 'function' || !canRequestFrames()))
      return 'a video frame source (MediaStreamTrackGenerator or canvas.captureStream)'
    if (!RTCRtpSender.getCapabilities('video')?.codecs.some((c) => /^video\/VP8$/i.test(c.mimeType))) return 'the VP8 codec'
    return null
  } catch {
    return 'WebRTC encoded transforms'
  }
}

/** What a connection's RTCConfiguration needs for the carrier (createEncodedStreams' flag). */
export function carrierConfig(): Partial<RTCConfiguration> {
  return transformApi() === 'legacy' ? ({ encodedInsertableStreams: true } as Partial<RTCConfiguration>) : {}
}

/**
 * Adds `x-google-start-bitrate` (kbps) to every VP8 format of an SDP, in its fmtp line or a new
 * one. Applied to the remote description: Chromium takes a send codec's parameters from there.
 */
export function seedStartBitrate(sdp: string, kbps: number): string {
  const lines = sdp.split('\r\n')
  const pts = new Set<string>()
  for (const l of lines) {
    const m = /^a=rtpmap:(\d+) VP8\/90000/i.exec(l)
    if (m) pts.add(m[1])
  }
  if (!pts.size) return sdp
  const param = `x-google-start-bitrate=${Math.round(kbps)}`
  const withFmtp = new Set<string>()
  const out = lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l)
    if (!m || !pts.has(m[1])) return l
    withFmtp.add(m[1])
    return /x-google-start-bitrate=/.test(m[2]) ? l : `${l};${param}`
  })
  const res: string[] = []
  for (const l of out) {
    res.push(l)
    const m = /^a=rtpmap:(\d+) VP8\/90000/i.exec(l)
    if (m && !withFmtp.has(m[1])) res.push(`a=fmtp:${m[1]} ${param}`)
  }
  return res.join('\r\n')
}

/**
 * How to make a canvas capture produce a frame: the track's requestFrame() (Chromium), else the
 * stream's (Firefox has it on CanvasCaptureMediaStream only). Null if neither has one.
 */
export function frameRequester(stream: MediaStream, track: MediaStreamTrack): (() => void) | null {
  const t = track as MediaStreamTrack & { requestFrame?: () => void }
  if (typeof t.requestFrame === 'function') return () => t.requestFrame!()
  const st = stream as MediaStream & { requestFrame?: () => void }
  if (typeof st.requestFrame === 'function') return () => st.requestFrame!()
  return null
}

/** Whether a canvas capture can be asked for frames (see frameRequester), without making one. */
function canRequestFrames(): boolean {
  const g = globalThis as unknown as Record<string, { prototype?: { requestFrame?: unknown } } | undefined>
  return typeof g.CanvasCaptureMediaStreamTrack?.prototype?.requestFrame === 'function' || typeof g.CanvasCaptureMediaStream?.prototype?.requestFrame === 'function'
}

/** The carrier track and how to write its next frame; `onFail` if a frame can't be written. */
function carrierTrack(onFail: () => void): { track: MediaStreamTrack; next: () => void; stop: () => void } {
  let n = 0
  if (hasGenerator()) {
    const gen = new MediaStreamTrackGenerator!({ kind: 'video' })
    const writer = gen.writable.getWriter()
    // I420: a mid-grey frame with one changing pixel, so each frame is a (tiny) delta.
    const buf = new Uint8Array((CARRIER_SIZE * CARRIER_SIZE * 3) / 2).fill(128)
    let pending = false
    let failed = false
    return {
      track: gen,
      next: () => {
        // A frame still being written (the page was busy): skip a tick rather than queue them.
        if (pending || failed) return
        buf[n % (CARRIER_SIZE * CARRIER_SIZE)] = (n * 37) & 0xff
        const f = new VideoFrame(buf, { format: 'I420', codedWidth: CARRIER_SIZE, codedHeight: CARRIER_SIZE, timestamp: Math.round((n++ * 1e6) / CARRIER_FPS) })
        pending = true
        writer.write(f).then(
          () => (pending = false),
          (err) => {
            // The writer is errored for good: no more frames, so the connection carries nothing.
            pending = false
            failed = true
            f.close()
            console.warn('carrier: track write failed', err)
            onFail()
          },
        )
      },
      stop: () => {
        writer.close().catch(() => {})
        gen.stop()
      },
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = CARRIER_SIZE
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0]
  const requestFrame = frameRequester(stream, track) ?? (() => {})
  return {
    track,
    next: () => {
      ctx.fillStyle = `rgb(${(n++ * 37) & 0xff},128,128)`
      ctx.fillRect(0, 0, 1, 1)
      requestFrame()
    },
    stop: () => track.stop(),
  }
}

type Streams = { readable: ReadableStream; writable: WritableStream }

/** The carrier of one RTCPeerConnection (see the top of this file). */
export class CarrierLink {
  readonly probeLink: ProbeLink
  /** The carrier is idle (keepalive frames only; set from the worker). */
  idle = false
  onMedia: (data: Uint8Array) => void = () => {}
  onBufferLow: () => void = () => {}

  private readonly api: TransformApi
  private readonly carrier: ReturnType<typeof carrierTrack>
  private worker: Worker | null = null
  private readonly attached = new WeakSet<object>()
  /** createEncodedStreams() streams waiting for the worker (it starts with the connection). */
  private streams: { side: 'send' | 'recv'; s: Streams }[] = []
  private transceiver: RTCRtpTransceiver | null = null
  private answerSender: RTCRtpSender | null = null
  /** Media bytes handed to the worker and packed by it, and the send rate the worker has. */
  private readonly buf = new CarrierBuffer()
  /** Padding likewise. */
  private padHanded = 0
  private padPacked = 0
  private outbox: ArrayBuffer[] = []
  private padOutbox = 0
  private flushQueued = false
  private started = false
  private closed = false
  private poll: (() => void) | null = null
  private watch: TickWatch | null = null
  private lastStatsAt = -Infinity
  /** The lowest round trip seen (ms), which sets the cap. */
  private rttMs: number | null = null

  constructor(
    private readonly pc: RTCPeerConnection,
    /** Whether the connection carries media now (its owner's state). */
    private readonly open: () => boolean,
    private readonly linkState: () => LinkState,
    /** The carrier failed (its worker, a transform or the track): the connection should go. */
    private readonly onFail: () => void,
  ) {
    this.api = transformApi() ?? 'legacy'
    this.carrier = carrierTrack(() => this.fail())
    pc.addEventListener('track', (ev) => this.attach(ev.receiver, 'recv'))
    const link = this
    this.probeLink = {
      get isOpen() {
        return link.open()
      },
      get state() {
        return link.linkState()
      },
      get bufferedAmount() {
        return link.padHanded - link.padPacked
      },
      onBufferLow: null,
      send(data: Uint8Array) {
        if (!link.open()) return false
        // Only the length matters: the worker packs zeros (padding), which the receiver drops.
        link.padHanded += data.byteLength
        link.padOutbox += data.byteLength
        link.scheduleFlush()
        return true
      },
    }
  }

  /** Offerer: the carrier transceiver, before the offer is made. */
  addForOffer(): void {
    const tr = this.pc.addTransceiver(this.carrier.track, {
      direction: 'sendrecv',
      sendEncodings: [{ maxBitrate: CARRIER_MAX_KBPS * 1000, maxFramerate: CARRIER_FPS }],
    })
    this.setup(tr)
  }

  /**
   * Answerer, before the remote offer is set: the carrier track (addTrack, so the offer's video
   * section takes this transceiver over rather than making its own), with its send transform set
   * now. Chromium's sender ran no transform set on a transceiver the offer had made.
   */
  addForAnswer(): void {
    this.answerSender = this.pc.addTrack(this.carrier.track)
    this.attach(this.answerSender, 'send')
  }

  /** Answerer, after the remote offer is set: the transceiver it took over, before the answer. */
  afterRemoteOffer(): void {
    const tr = this.pc.getTransceivers().find((t) => t.sender === this.answerSender)
    if (!tr) throw new Error('carrier: the offer has no video section')
    tr.direction = 'sendrecv'
    this.setup(tr)
  }

  /** The remote description as the browser should take it (the start bitrate seeded). */
  remoteSdp(sdp: string): string {
    return seedStartBitrate(sdp, CARRIER_START_KBPS)
  }

  /** VP8 only (with its retransmissions), and the send transform. */
  private setup(tr: RTCRtpTransceiver): void {
    this.transceiver = tr
    const codecs = (RTCRtpSender.getCapabilities('video')?.codecs ?? []).filter((c) => /^video\/(VP8|rtx)$/i.test(c.mimeType))
    try {
      tr.setCodecPreferences(codecs)
    } catch (err) {
      console.warn('carrier: codec preferences refused', err)
    }
    this.attach(tr.sender, 'send')
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const w = new Worker(new URL('./carrierWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => this.fromWorker(ev.data as Record<string, unknown>)
    w.onerror = (ev) => {
      console.warn('carrier worker failed', ev.message)
      this.fail()
    }
    w.onmessageerror = () => {
      console.warn('carrier worker: a message could not be read')
      this.fail()
    }
    this.buf.rateKbps = Math.min(CARRIER_START_KBPS, this.maxKbps)
    w.postMessage({ op: 'rate', kbps: this.buf.rateKbps })
    this.worker = w
    return w
  }

  private attach(endpoint: RTCRtpSender | RTCRtpReceiver, side: 'send' | 'recv'): void {
    if (this.attached.has(endpoint) || this.closed) return
    this.attached.add(endpoint)
    if (this.api === 'script') {
      endpoint.transform = new RTCRtpScriptTransform(this.ensureWorker(), { side })
      return
    }
    const s = (endpoint as unknown as { createEncodedStreams(): Streams }).createEncodedStreams()
    if (this.started) this.postStreams(side, s)
    else this.streams.push({ side, s })
  }

  private postStreams(side: 'send' | 'recv', s: Streams): void {
    this.ensureWorker().postMessage({ op: 'stream', side, readable: s.readable, writable: s.writable }, [
      s.readable as unknown as Transferable,
      s.writable as unknown as Transferable,
    ])
  }

  /** The connection is up (ICE and DTLS): the worker takes over the transforms and starts the clock. */
  start(): void {
    if (this.started || this.closed) return
    this.started = true
    const w = this.ensureWorker()
    for (const { side, s } of this.streams) this.postStreams(side, s)
    this.streams = []
    w.postMessage({ op: 'start', fps: CARRIER_FPS, idleFps: CARRIER_IDLE_FPS, idleMs: CARRIER_IDLE_MS })
    void this.tuneSender()
    const watch = (this.watch = new TickWatch(performance.now()))
    this.poll = every(ESTIMATE_POLL_MS, () => {
      if (watch.hung(performance.now())) {
        console.warn('carrier worker stopped ticking')
        this.fail()
        return
      }
      void this.pollEstimate()
    })
    this.flush()
  }

  /** The carrier can't go on (its worker, transform or track failed): the connection should go. */
  private fail(): void {
    if (this.closed) return
    this.close()
    this.onFail()
  }

  /** Bytes handed over and not yet packed into a carrier frame. */
  get bufferedAmount(): number {
    return this.buf.amount
  }

  /** How much the uplink may hand over at once (see CARRIER_BUFFER_MS). */
  get bufferHigh(): number {
    return this.buf.high
  }

  send(data: Uint8Array): boolean {
    if (!this.open() || data.byteLength > MAX_CARRIER_MESSAGE) return false
    // A copy: the same fragment may be queued for other links, and the copy is transferred.
    this.outbox.push(data.slice().buffer)
    this.buf.handed += data.byteLength
    this.scheduleFlush()
    return true
  }

  private scheduleFlush(): void {
    if (this.flushQueued) return
    this.flushQueued = true
    queueMicrotask(() => this.flush())
  }

  private flush(): void {
    this.flushQueued = false
    if (!this.started || this.closed) return
    if (this.outbox.length) {
      const msgs = this.outbox
      this.outbox = []
      this.worker!.postMessage({ op: 'send', msgs }, msgs)
    }
    if (this.padOutbox) {
      this.worker!.postMessage({ op: 'pad', bytes: this.padOutbox })
      this.padOutbox = 0
    }
  }

  private fromWorker(d: Record<string, unknown>): void {
    if (this.closed) return
    switch (d.op) {
      case 'tick':
        this.watch?.tick(performance.now())
        this.carrier.next()
        return
      case 'idle':
        this.idle = !!d.idle
        // Busy again: the rate it has may be seconds old.
        if (!this.idle) void this.pollEstimate()
        return
      case 'packed': {
        const media = d.media as number
        const pad = d.pad as number
        if (media && this.buf.pack(media)) this.onBufferLow()
        if (pad) {
          const before = this.probeLink.bufferedAmount
          this.padPacked += pad
          const low = BACKGROUND_BUFFER_MAX / 2
          if (before > low && this.probeLink.bufferedAmount <= low) this.probeLink.onBufferLow?.()
        }
        return
      }
      case 'recv': {
        if (!this.open()) return
        const buf = d.buf as ArrayBuffer
        const offs = d.offs as number[]
        for (let i = 0; i + 1 < offs.length; i += 2) this.onMedia(new Uint8Array(buf, offs[i], offs[i + 1]))
        return
      }
      case 'error':
        console.warn(`carrier ${d.side} transform failed`, d.error)
        this.fail()
        return
    }
  }

  /** Keep the frame rate whatever the estimate (the frames carry the data, not the picture). */
  private async tuneSender(): Promise<void> {
    const sender = this.transceiver?.sender
    if (!sender) return
    try {
      const p = sender.getParameters()
      p.degradationPreference = 'maintain-framerate'
      for (const e of p.encodings) {
        e.maxBitrate = CARRIER_MAX_KBPS * 1000
        e.maxFramerate = CARRIER_FPS
      }
      await sender.setParameters(p)
    } catch (err) {
      console.warn('carrier: setParameters failed', err)
    }
  }

  /** The most this connection sends now (kbps): carrierCapKbps for its round trip. */
  get maxKbps(): number {
    return carrierCapKbps(this.rttMs)
  }

  /** A getStats() report of the connection: the browser's estimate, capped, is the send rate. */
  noteStats(report: StatsLike): void {
    this.lastStatsAt = performance.now()
    const r = parseLinkStats(report)
    const rtt = r?.currentRttMs
    if (rtt != null && rtt >= 0) this.rttMs = this.rttMs === null ? rtt : Math.min(this.rttMs, rtt)
    const bps = r?.availableBps
    if (bps != null && bps > 0 && this.worker && !this.closed) {
      const kbps = Math.min(bps / 1000, this.maxKbps)
      const wake = this.buf.setRate(kbps)
      this.worker.postMessage({ op: 'rate', kbps })
      if (wake) this.onBufferLow()
    }
  }

  /** Reads the estimate while the carrier is busy, unless a stats poll just did (connMetrics). */
  private async pollEstimate(): Promise<void> {
    if (this.idle || this.closed || performance.now() - this.lastStatsAt < ESTIMATE_POLL_MS * 0.9) return
    try {
      this.noteStats((await this.pc.getStats()) as unknown as StatsLike)
    } catch {
      // closed
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.poll?.()
    this.poll = null
    this.outbox = []
    this.worker?.terminate()
    this.carrier.stop()
  }
}
