// A mesh connection's carrier worker (carrierLink.ts): the encoded transforms of its carrier track,
// and the clock that drives the track's frames. One per open connection.
//
// Send side: every frame the VP8 encoder produces (a 16×16 frame, ~70 bytes) is swapped for a
// carrier frame (net/carrier.ts): the original frame as the prefix, then the messages the page
// handed over, as many as the send budget (a token bucket at the browser's bandwidth estimate,
// capped) covers, then padding (a headroom probe's bytes) in what is left. The browser then
// packetizes, paces and retransmits it as video, under its own congestion control.
//
// Receive side: every carrier frame's messages go to the page, and the decoder gets the original
// tiny frame back. That last part is not optional: Chromium frees its RTP packet buffer only as
// frames are decoded, and with nothing decoded it overflows, drops frames with no packet lost, and
// asks for a keyframe several times a second (measured with e2e/diag-rtp.spec.ts).
//
// The clock: `fps` while there is something to send, `idleFps` once nothing has been for `idleMs`
// (a lobby's idle pairs shouldn't each run an encoder at 100 fps), and back at once when something
// comes.
//
// The transforms arrive as transferred streams in a `stream` message (createEncodedStreams), or as
// RTCRtpScriptTransform events (`rtctransform`): the same code handles both.
//
// Messages, page -> worker:
//   { op: 'start', fps, idleFps, idleMs }      start the frame clock
//   { op: 'send', msgs: ArrayBuffer[] }        messages to pack (in order)
//   { op: 'pad', bytes }                       padding to add when there is room
//   { op: 'rate', kbps }                       the send budget's rate
//   { op: 'stream', side, readable, writable } a transform's streams
// worker -> page:
//   { op: 'tick' }                             write the next carrier track frame
//   { op: 'idle', idle }                       the clock slowed down (true) or sped up (false)
//   { op: 'packed', media, pad }               bytes of messages / padding put in frames since the last
//   { op: 'recv', buf, offs }                  received messages: [start, length] pairs into `buf`
//                                              (just the messages, copied: compactMessages)
//   { op: 'error', side, error }
import { CarrierBudget, CarrierPacker, compactMessages, nextCarrierFrame, unpackCarrierFrame } from '../net/carrier'

/** The parts of an encoded frame used here (RTCEncodedVideoFrame). */
interface EncodedFrame {
  data: ArrayBuffer
  /** The RTP timestamp, where getMetadata() has no rtpTimestamp (older Chromium). */
  timestamp?: number
  getMetadata(): { rtpTimestamp?: number }
}

interface Scope {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent) => void) | null
  onrtctransform: ((ev: { transformer: { readable: ReadableStream; writable: WritableStream; options?: { side?: string } } }) => void) | null
}

const scope = self as unknown as Scope

/** Received frames remembered by RTP timestamp, to drop duplicates (the transform sees a few). */
const DEDUPE_WINDOW = 256

const packer = new CarrierPacker()
const budget = new CarrierBudget(0)
let padPending = 0
let packedMedia = 0
let packedPad = 0
let flushQueued = false

let fastFps = 100
let idleFps = 5
let idleMs = 2000
let clock: ReturnType<typeof setInterval> | null = null
let idle = false
let busyAt = 0

const seen = new Set<number>()
const seenOrder: number[] = []

function setClock(fps: number): void {
  if (clock !== null) clearInterval(clock)
  clock = setInterval(tick, 1000 / fps)
}

function tick(): void {
  scope.postMessage({ op: 'tick' })
  if (!idle && performance.now() - busyAt > idleMs) {
    idle = true
    setClock(idleFps)
    scope.postMessage({ op: 'idle', idle: true })
  }
}

/** Something to send: full speed, with a frame right away if the clock was slow. */
function busy(): void {
  busyAt = performance.now()
  if (!idle || clock === null) return
  idle = false
  setClock(fastFps)
  scope.postMessage({ op: 'idle', idle: false })
  tick()
}

function flushPacked(): void {
  flushQueued = false
  if (packedMedia === 0 && packedPad === 0) return
  scope.postMessage({ op: 'packed', media: packedMedia, pad: packedPad })
  packedMedia = 0
  packedPad = 0
}

function send(frame: EncodedFrame, controller: TransformStreamDefaultController<EncodedFrame>): void {
  const r = nextCarrierFrame(packer, budget, performance.now(), new Uint8Array(frame.data), padPending)
  padPending -= r.padded
  frame.data = r.frame.buffer as ArrayBuffer
  controller.enqueue(frame)
  if (packer.length || padPending > 0) busyAt = performance.now()
  if (r.taken || r.padded) {
    packedMedia += r.taken
    packedPad += r.padded
    // One report per burst of frames, not one per frame.
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flushPacked)
    }
  }
}

function recv(frame: EncodedFrame, controller: TransformStreamDefaultController<EncodedFrame>): void {
  const ts = frame.getMetadata().rtpTimestamp ?? frame.timestamp
  if (ts !== undefined) {
    if (seen.has(ts)) return
    seen.add(ts)
    seenOrder.push(ts)
    if (seenOrder.length > DEDUPE_WINDOW) seen.delete(seenOrder.shift()!)
  }
  const c = unpackCarrierFrame(new Uint8Array(frame.data))
  // Not a carrier frame: the decoder's as is.
  if (!c) return controller.enqueue(frame)
  frame.data = c.prefix.slice().buffer
  controller.enqueue(frame)
  if (!c.messages.length) return
  const { buf, offs } = compactMessages(c.messages)
  scope.postMessage({ op: 'recv', buf, offs }, [buf])
}

function run(side: string, readable: ReadableStream, writable: WritableStream): void {
  readable
    .pipeThrough(new TransformStream<EncodedFrame, EncodedFrame>({ transform: side === 'send' ? send : recv }))
    .pipeTo(writable)
    .catch((e) => scope.postMessage({ op: 'error', side, error: String(e) }))
}

scope.onrtctransform = (ev) => {
  const t = ev.transformer
  run(t.options?.side ?? 'recv', t.readable, t.writable)
}

scope.onmessage = (ev: MessageEvent) => {
  const d = ev.data as Record<string, unknown>
  switch (d.op) {
    case 'send':
      for (const b of d.msgs as ArrayBuffer[]) packer.push(new Uint8Array(b))
      busy()
      return
    case 'pad':
      padPending += d.bytes as number
      busy()
      return
    case 'rate':
      budget.rateKbps = d.kbps as number
      return
    case 'start':
      // A worker's timers aren't throttled in a hidden tab, the page's are.
      fastFps = d.fps as number
      idleFps = d.idleFps as number
      idleMs = d.idleMs as number
      busyAt = performance.now()
      if (clock === null) setClock(fastFps)
      return
    case 'stream':
      run(d.side as string, d.readable as ReadableStream, d.writable as WritableStream)
      return
  }
}
