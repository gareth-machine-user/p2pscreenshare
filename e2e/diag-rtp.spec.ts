import { test, type Page } from '@playwright/test'
import { closeContexts, newContext } from './helpers'

// Opt-in diagnostic (E2E_DIAG=1): can bulk bytes ride inside the encoded frames of a dummy VP8
// "carrier" video track (encoded transforms), so they get RTP's congestion control (GCC), NACK/RTX
// and pacing instead of SCTP's? Two pages, one RTCPeerConnection each; page A sends a tiny generated
// video track, its sender transform appends a slice of a bulk byte queue (16 KiB messages, each with
// a sequence number, send time and checksum) to every encoded frame; page B's receiver transform
// unpacks and verifies them, then hands the decoder only the original tiny VP8 frame. Prints throughput per 500 ms,
// the bandwidth estimate over time, the longest delivery gaps, losses, one-way latency and the RTP
// stats (NACK/PLI/FIR...). Go/no-go spike for a real RTP transport; nothing here is app code.
//
// Env: DIAG_SECONDS (30), DIAG_FPS (100), DIAG_API (script | legacy; default: script if available),
// DIAG_GEN (mstg | canvas; default mstg if available), DIAG_KEEP (frame | header: keep the whole
// encoded carrier frame, or only its VP8 payload header), DIAG_KEY=1 (ask for a keyframe every frame),
// DIAG_HEADROOM (budget = estimate × this; default 1), DIAG_DECODE=0 (drop every carrier frame instead of
// handing the decoder the original tiny VP8 frame; see below).

test.afterEach(closeContexts)

type Any = any

async function page(browser: Any, name: string): Promise<Page> {
  const ctx = await newContext(browser)
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message))
  p.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('[diag]')) console.log(`[${name}]`, m.text())
  })
  await p.goto('about:blank')
  return p
}

// The transform worker, shared by both sides. Wire format appended to each carrier frame:
//   kept carrier bytes | chunks | trailer
//   chunk:   seq u32, total u32, offset u32, len u32, bytes[len]
//   trailer: frameNo u32, keptLen u32, chunkBytes u32, MAGIC u32
// A message is 16 KiB: seq u32, sendTs f64 (epoch ms, set when its first byte is sent), len u32,
// checksum u32 (over bytes 20..end), then pseudo-random bytes derived from seq.
const WORKER_SRC = `
const MAGIC = 0x52545031, MSG = 16384, HDR = 20, CH = 16, TR = 16
const now = () => performance.timeOrigin + performance.now()
let decode = false, est = 0, fps = 100, keep = 'frame', headroom = 1, forceKey = false, stopping = false, stopped = false
// sender
let nextSeq = 0, cur = null, curOff = 0, frameNo = 0, sentMsgs = 0, sentBytes = 0, framesOut = 0, keyOut = 0, deltaOut = 0
let origMax = 0, origSum = 0, keyTransformer = null, keyReqs = 0, keyReqErr = ''
const sentLog = []
// receiver
const partial = new Map(), done = new Set()
let out = [], fout = [], stats = { frames: 0, badFrames: 0, dupFrames: 0, dupChunks: 0, corrupt: 0, complete: 0, bytes: 0, key: 0, delta: 0 }
const seenFrames = new Set()

function sum(u8, from) {
  const w = new Uint32Array(u8.buffer, u8.byteOffset + from, (u8.length - from) >> 2)
  let h = 0x811c9dc5
  for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w[i], 16777619)
  return h >>> 0
}
function makeMsg(seq) {
  const b = new Uint8Array(MSG), dv = new DataView(b.buffer)
  let x = (Math.imul(seq + 1, 2654435761) >>> 0) || 1
  const w = new Uint32Array(b.buffer, HDR)
  for (let i = 0; i < w.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; w[i] = x >>> 0 }
  dv.setUint32(0, seq, true); dv.setUint32(12, MSG, true); dv.setUint32(16, sum(b, HDR), true)
  return b
}

function send(frame, controller) {
  const orig = new Uint8Array(frame.data)
  const isKey = frame.type === 'key'
  if (isKey) keyOut++; else deltaOut++
  origMax = Math.max(origMax, orig.length); origSum += orig.length
  const kept = keep === 'header' ? Math.min(orig.length, isKey ? 10 : 3) : orig.length
  const bps = (est > 0 ? est : 1e6) * headroom
  let budget = Math.floor(bps / 8 / fps) - kept - TR
  const parts = []
  let chunkBytes = 0
  const t = now()
  while (!stopped && budget > CH) {
    if (!cur) {
      if (stopping) { stopped = true; break }
      cur = makeMsg(nextSeq++); curOff = 0
    }
    if (curOff === 0) new DataView(cur.buffer).setFloat64(4, t, true)
    const n = Math.min(budget - CH, MSG - curOff)
    const seq = new DataView(cur.buffer).getUint32(0, true)
    parts.push([seq, curOff, cur.subarray(curOff, curOff + n)])
    budget -= CH + n; chunkBytes += CH + n; curOff += n
    if (curOff === MSG) { cur = null; sentMsgs++ }
  }
  const buf = new Uint8Array(kept + chunkBytes + TR), dv = new DataView(buf.buffer)
  buf.set(orig.subarray(0, kept), 0)
  let o = kept
  for (const [seq, off, bytes] of parts) {
    dv.setUint32(o, seq, true); dv.setUint32(o + 4, MSG, true); dv.setUint32(o + 8, off, true); dv.setUint32(o + 12, bytes.length, true)
    buf.set(bytes, o + CH); o += CH + bytes.length
  }
  dv.setUint32(o, frameNo++, true); dv.setUint32(o + 4, kept, true); dv.setUint32(o + 8, chunkBytes, true); dv.setUint32(o + 12, MAGIC, true)
  frame.data = buf.buffer
  sentBytes += buf.length; framesOut++
  sentLog.push([frameNo - 1, t, isKey ? 1 : 0, buf.length, frame.getMetadata().rtpTimestamp ?? frame.timestamp])
  controller.enqueue(frame)
  if (forceKey && keyTransformer) { keyReqs++; keyTransformer.generateKeyFrame().catch((e) => { keyReqErr = String(e) }) }
}

function recv(frame, controller) {
  const t = now()
  const b = new Uint8Array(frame.data)
  if (b.length < TR) { stats.badFrames++; return }
  const dv = new DataView(b.buffer, b.byteOffset, b.length)
  const e = b.length - TR
  if (dv.getUint32(e + 12, true) !== MAGIC) { stats.badFrames++; return }
  const fno = dv.getUint32(e, true), kept = dv.getUint32(e + 4, true), cb = dv.getUint32(e + 8, true)
  if (kept + cb !== e) { stats.badFrames++; return }
  if (seenFrames.has(fno)) { stats.dupFrames++; return }
  seenFrames.add(fno); stats.frames++
  if (frame.type === 'key') stats.key++; else stats.delta++
  fout.push([fno, t, b.length])
  let o = kept
  while (o + CH <= e) {
    const seq = dv.getUint32(o, true), total = dv.getUint32(o + 4, true), off = dv.getUint32(o + 8, true), len = dv.getUint32(o + 12, true)
    o += CH
    if (o + len > e || total !== MSG || off + len > MSG) { stats.badFrames++; break }
    if (done.has(seq)) { stats.dupChunks++; o += len; continue }
    let m = partial.get(seq)
    if (!m) { m = { buf: new Uint8Array(MSG), offs: new Set(), got: 0 }; partial.set(seq, m) }
    if (m.offs.has(off)) { stats.dupChunks++; o += len; continue }
    m.offs.add(off); m.buf.set(b.subarray(o, o + len), off); m.got += len; o += len
    if (m.got >= MSG) {
      partial.delete(seq); done.add(seq)
      const mv = new DataView(m.buf.buffer)
      const ok = mv.getUint32(0, true) === seq && mv.getUint32(12, true) === MSG && mv.getUint32(16, true) === sum(m.buf, HDR)
      if (!ok) stats.corrupt++; else { stats.complete++; stats.bytes += MSG }
      out.push([seq, MSG, t, mv.getFloat64(4, true), ok ? 1 : 0])
    }
  }
  // Hand the decoder the original carrier frame (stripped of our bytes). Chromium frees its RTP
  // packet buffer only as frames decode: with nothing decoded (DIAG_DECODE=0), the buffer fills
  // every ~2k packets, is cleared (a frame lost with zero packet loss) and a keyframe is requested,
  // and the stalled decoder sends a PLI every ~300 ms.
  if (decode && kept > 0) { frame.data = b.slice(0, kept).buffer; controller.enqueue(frame) }
}

setInterval(() => {
  if (out.length || fout.length) { postMessage({ op: 'recv', msgs: out, frames: fout }); out = []; fout = [] }
}, 200)

function run(side, readable, writable, opts) {
  fps = opts.fps; keep = opts.keep; decode = !!opts.decode; headroom = opts.headroom; forceKey = opts.forceKey
  readable.pipeThrough(new TransformStream({ transform: side === 'send' ? send : recv })).pipeTo(writable)
    .catch((e) => postMessage({ op: 'error', side, error: String(e) }))
  postMessage({ op: 'started', side })
}
self.onrtctransform = (ev) => {
  const tr = ev.transformer
  if (tr.options.side === 'send') keyTransformer = tr
  run(tr.options.side, tr.readable, tr.writable, tr.options)
}
self.onmessage = (ev) => {
  const d = ev.data
  if (d.op === 'est') est = d.bps
  else if (d.op === 'stream') run(d.side, d.readable, d.writable, d.opts)
  else if (d.op === 'stop') stopping = true
  else if (d.op === 'sender-stats') postMessage({ op: 'sender-stats', s: { nextSeq, sentMsgs, sentBytes, framesOut, keyOut, deltaOut, origMax, origAvg: framesOut ? origSum / framesOut : 0, stopped, keyReqs, keyReqErr, sentLog } })
  else if (d.op === 'recv-stats') postMessage({ op: 'recv-stats', s: { ...stats, partial: partial.size } })
}
`

function setup(opts: Record<string, Any>): string {
  return `(() => {
  const opts = ${JSON.stringify(opts)}
  const hasScript = typeof RTCRtpScriptTransform === 'function'
  const api = opts.api || (hasScript ? 'script' : 'legacy')
  const cfg = { iceServers: [] }
  if (api === 'legacy') cfg.encodedInsertableStreams = true
  const pc = new RTCPeerConnection(cfg)
  const worker = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER_SRC)}], { type: 'text/javascript' })))
  const t = window.__t = { pc, worker, api, opts, msgs: [], frames: [], est: [], replies: {}, errors: [], info: { api, hasScript, hasLegacy: typeof RTCRtpSender.prototype.createEncodedStreams === 'function', hasMSTG: typeof MediaStreamTrackGenerator === 'function', hasVTG: typeof VideoTrackGenerator === 'function' } }
  worker.onmessage = (e) => {
    const d = e.data
    if (d.op === 'recv') { for (const m of d.msgs) t.msgs.push(m); for (const f of d.frames) t.frames.push(f) }
    else if (d.op === 'error') { t.errors.push(d); console.log('[diag] worker error ' + JSON.stringify(d)) }
    else if (d.op === 'started') t.info['started_' + d.side] = true
    else t.replies[d.op] = d.s
  }
  t.ask = (op) => new Promise((r) => { delete t.replies[op]; worker.postMessage({ op }); const iv = setInterval(() => { if (t.replies[op]) { clearInterval(iv); r(t.replies[op]) } }, 20) })
  t.attach = (endpoint, side) => {
    const o = { side, decode: opts.decode, fps: opts.fps, keep: opts.keep, headroom: opts.headroom, forceKey: opts.forceKey }
    if (api === 'script') endpoint.transform = new RTCRtpScriptTransform(worker, o)
    else { const { readable, writable } = endpoint.createEncodedStreams(); worker.postMessage({ op: 'stream', side, readable, writable, opts: o }, [readable, writable]) }
  }
  pc.ontrack = (e) => { t.attach(e.receiver, 'recv'); t.info.ontrack = true }
  return true
})()`
}

// Page A: the carrier track (16×16 at DIAG_FPS), a sendonly VP8(+RTX) transceiver and the sender transform.
const START_SENDER = `(() => {
  const t = window.__t, fps = t.opts.fps
  const W = 16, H = 16
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  let track, gen = t.opts.gen, n = 0, draw
  const paint = () => { ctx.fillStyle = 'hsl(' + ((n * 7) % 360) + ',80%,50%)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(n % W, (n >> 4) % H, 2, 2) }
  if ((!gen || gen === 'mstg') && typeof MediaStreamTrackGenerator === 'function') {
    gen = 'MediaStreamTrackGenerator'
    const g = new MediaStreamTrackGenerator({ kind: 'video' })
    const w = g.writable.getWriter()
    track = g
    draw = () => { paint(); w.write(new VideoFrame(canvas, { timestamp: Math.round(n * 1e6 / fps) })).catch(() => {}) }
  } else {
    gen = 'canvas.captureStream(0)'
    track = canvas.captureStream(0).getVideoTracks()[0]
    draw = () => { paint(); track.requestFrame() }
  }
  t.info.gen = gen
  t.genCount = 0
  // A worker clock (main-thread timers are clamped/throttled); one frame per tick.
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), ' + (1000 / fps) + ')'], { type: 'text/javascript' })))
  ticker.onmessage = () => { if (t.genStop) return; n++; t.genCount++; draw() }
  t.ticker = ticker
  const tr = t.pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 50_000_000, maxFramerate: fps }] })
  const codecs = RTCRtpSender.getCapabilities('video').codecs.filter((c) => /^video\\/(VP8|rtx)$/i.test(c.mimeType))
  tr.setCodecPreferences(codecs)
  t.info.codecs = codecs.map((c) => c.mimeType + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine : '')).join(', ')
  t.tr = tr
  t.attach(tr.sender, 'send')
  return true
})()`

const GATHER = `new Promise((r) => { const pc = window.__t.pc; if (pc.iceGatheringState === 'complete') r(pc.localDescription.sdp); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(pc.localDescription.sdp) })`

// Every second: the selected pair's availableOutgoingBitrate, posted to the worker, plus outbound-rtp.
const START_POLL = `(async () => {
  const t = window.__t, sender = t.tr.sender
  const p = sender.getParameters()
  p.degradationPreference = 'maintain-framerate'
  for (const e of p.encodings) { e.maxBitrate = 50_000_000; e.maxFramerate = t.opts.fps }
  try { await sender.setParameters(p); t.info.setParameters = 'ok' } catch (e) { t.info.setParameters = String(e) }
  t.info.params = JSON.stringify(sender.getParameters().encodings) + ' degr=' + sender.getParameters().degradationPreference
  t.t0 = performance.timeOrigin + performance.now()
  const poll = async () => {
    const s = await t.pc.getStats()
    let pairId, est, rtt, out = {}, rem = {}
    s.forEach((r) => { if (r.type === 'transport') pairId = r.selectedCandidatePairId })
    s.forEach((r) => {
      if (r.type === 'candidate-pair' && (r.id === pairId || (!pairId && r.nominated))) { est = r.availableOutgoingBitrate; rtt = r.currentRoundTripTime }
      if (r.type === 'outbound-rtp' && r.kind === 'video') out = r
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') rem = r
    })
    if (est > 0) t.worker.postMessage({ op: 'est', bps: est })
    t.est.push([performance.timeOrigin + performance.now(), est ?? null, rtt ?? null, out.bytesSent ?? 0, out.framesEncoded ?? 0, out.framesSent ?? 0, out.targetBitrate ?? null, out.totalPacketSendDelay ?? 0, out.packetsSent ?? 0, rem.packetsLost ?? null])
    t.lastOut = out; t.lastRem = rem
  }
  await poll()
  t.poll = setInterval(poll, 1000)
  return true
})()`

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : NaN)
const median = (xs: number[]) => pct([...xs].sort((a, b) => a - b), 50)

test('diagnostic: bulk bytes over RTP in a VP8 carrier track', async ({ browser }) => {
  test.skip(!process.env.E2E_DIAG, 'opt-in diagnostic (E2E_DIAG=1)')
  const seconds = Number(process.env.DIAG_SECONDS ?? 30)
  const fps = Number(process.env.DIAG_FPS ?? 100)
  const opts = {
    fps,
    api: process.env.DIAG_API ?? '',
    gen: process.env.DIAG_GEN ?? '',
    keep: process.env.DIAG_KEEP ?? 'frame',
    forceKey: !!process.env.DIAG_KEY,
    decode: process.env.DIAG_DECODE !== '0',
    headroom: Number(process.env.DIAG_HEADROOM ?? 1),
  }
  test.setTimeout((seconds + 90) * 1000)
  const a = await page(browser, 'A')
  const b = await page(browser, 'B')
  await a.evaluate(setup(opts))
  await b.evaluate(setup(opts))
  await a.evaluate(START_SENDER)
  const offer = await a.evaluate(`(async () => { const pc = window.__t.pc; await pc.setLocalDescription(await pc.createOffer()); return await ${GATHER} })()`)
  const answer = await b.evaluate(
    `(async () => { const pc = window.__t.pc; await pc.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(offer)} }); await pc.setLocalDescription(await pc.createAnswer()); return await ${GATHER} })()`,
  )
  await a.evaluate(`window.__t.pc.setRemoteDescription({ type: 'answer', sdp: ${JSON.stringify(answer)} })`)
  await a.waitForFunction(`window.__t.pc.connectionState === 'connected'`, undefined, { timeout: 20_000 })
  await a.evaluate(START_POLL)
  const t0: number = await a.evaluate(`window.__t.t0`)

  await new Promise((r) => setTimeout(r, seconds * 1000))
  // Stop: finish the message in progress, then carrier frames go out bare. Let the tail drain.
  await a.evaluate(`window.__t.worker.postMessage({ op: 'stop' })`)
  await new Promise((r) => setTimeout(r, 4000))
  const sender: Any = await a.evaluate(`(async () => { const t = window.__t; clearInterval(t.poll); t.genStop = true; const s = await t.ask('sender-stats'); return { s, est: t.est, info: t.info, genCount: t.genCount, out: t.lastOut, rem: t.lastRem, errors: t.errors } })()`)
  await new Promise((r) => setTimeout(r, 500))
  const recv: Any = await b.evaluate(`(async () => {
    const t = window.__t
    const s = await t.ask('recv-stats')
    const st = await t.pc.getStats(); let inb = {}
    st.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') inb = r })
    return { s, msgs: t.msgs, frames: t.frames, info: t.info, inb, errors: t.errors }
  })()`)

  const ss = sender.s
  const rs = recv.s
  const msgs = recv.msgs as [number, number, number, number, number][]
  const frames = recv.frames as [number, number, number][]
  console.log(`--- RTP carrier: ${seconds} s at ${fps} fps, keep=${opts.keep}, decode=${opts.decode}, forceKey=${opts.forceKey}, headroom=${opts.headroom}`)
  console.log(`APIs: sender ${JSON.stringify(sender.info)}`)
  console.log(`      receiver ${JSON.stringify(recv.info)}`)
  if (sender.errors.length || recv.errors.length) console.log(`errors: ${JSON.stringify([...sender.errors, ...recv.errors])}`)
  console.log(`generator frames ${sender.genCount}; encoder framesEncoded ${sender.out.framesEncoded} framesSent ${sender.out.framesSent}; transform frames out ${ss.framesOut} (key ${ss.keyOut}, delta ${ss.deltaOut}); carrier VP8 frame avg ${ss.origAvg.toFixed(1)} B, max ${ss.origMax} B${opts.forceKey ? `; keyframe requests ${ss.keyReqs} ${ss.keyReqErr}` : ''}`)

  // Throughput per 500 ms from t0 (both pages share the machine clock).
  const bins: number[] = new Array(Math.ceil((seconds + 4) * 2)).fill(0)
  for (const [, size, at, , ok] of msgs) if (ok) bins[Math.floor((at - t0) / 500)] = (bins[Math.floor((at - t0) / 500)] ?? 0) + size
  const mbps = bins.map((x) => (x * 8) / 0.5 / 1e6)
  console.log(`delivered Mbps per 500 ms: ${mbps.map((x) => x.toFixed(1)).join(' ')}`)
  const active = mbps.slice(0, seconds * 2)
  const secondHalf = active.slice(Math.floor(active.length / 2))
  const totalBytes = msgs.filter((m) => m[4]).reduce((s, m) => s + m[1], 0)
  console.log(`delivered ${(totalBytes / 1e6).toFixed(1)} MB = ${((totalBytes * 8) / seconds / 1e6).toFixed(2)} Mbps average; median 500 ms bin ${median(active).toFixed(2)} Mbps (whole run), ${median(secondHalf).toFixed(2)} Mbps (second half); sender put ${(ss.sentBytes / 1e6).toFixed(1)} MB in frames`)

  const est = sender.est as Any[]
  console.log(`estimate (Mbps) / RTT (ms) / sent Mbps / target Mbps / pacer delay ms per s:`)
  let prev: Any = null
  const rows: string[] = []
  for (const r of est) {
    const [at, e, rtt, bytes, , , target, psd, pkts] = r
    const sent = prev ? (((bytes - prev[3]) * 8) / ((at - prev[0]) / 1000) / 1e6).toFixed(1) : '-'
    const pd = prev && pkts > prev[8] ? (((psd - prev[7]) / (pkts - prev[8])) * 1000).toFixed(0) : '-'
    rows.push(`${((at - t0) / 1000).toFixed(0)}s:${e == null ? '-' : (e / 1e6).toFixed(2)}/${rtt == null ? '-' : Math.round(rtt * 1000)}/${sent}/${target == null ? '-' : (target / 1e6).toFixed(2)}/${pd}`)
    prev = r
  }
  console.log('  ' + rows.join(' '))

  // Delivery gaps: between consecutive completed messages, from the first arrival to the stop.
  const arrivals = msgs.filter((m) => m[4]).map((m) => m[2]).sort((x, y) => x - y)
  const gaps: { at: number; ms: number }[] = []
  for (let i = 1; i < arrivals.length; i++) if (arrivals[i] - t0 < seconds * 1000) gaps.push({ at: (arrivals[i - 1] - t0) / 1000, ms: arrivals[i] - arrivals[i - 1] })
  gaps.sort((x, y) => y.ms - x.ms)
  console.log(`5 longest delivery gaps: ${gaps.slice(0, 5).map((g) => `${Math.round(g.ms)} ms @${g.at.toFixed(1)}s`).join(', ')}`)
  const first = arrivals.length ? arrivals[0] - t0 : NaN
  console.log(`first message arrived ${Math.round(first)} ms after t0`)

  // Losses: every message the sender completed (sentMsgs) must arrive once, intact.
  const got = new Set<number>()
  let dup = 0
  for (const m of msgs) {
    if (got.has(m[0])) dup++
    got.add(m[0])
  }
  let lost = 0
  for (let s = 0; s < ss.sentMsgs; s++) if (!got.has(s)) lost++
  console.log(`messages: sent ${ss.sentMsgs}, received ${got.size}, lost ${lost}, corrupt ${rs.corrupt}, duplicate ${dup} (dup chunks ${rs.dupChunks}, dup frames ${rs.dupFrames}, bad frames ${rs.badFrames}, partial at end ${rs.partial})`)

  const lat = msgs.filter((m) => m[4]).map((m) => m[2] - m[3]).sort((x, y) => x - y)
  console.log(`one-way latency (first byte sent -> message complete): p50 ${pct(lat, 50).toFixed(0)} ms, p95 ${pct(lat, 95).toFixed(0)} ms, max ${pct(lat, 100).toFixed(0)} ms`)

  // Head of line: carrier frames that went missing. Each either arrived late (NACK/RTX) or never.
  // After a frame goes missing, did the next frames keep arriving (no stall until a keyframe)?
  const byNo = new Map<number, number>()
  for (const [no, at] of frames) byNo.set(no, at)
  const order = [...frames].sort((x, y) => x[1] - y[1])
  const maxNo = Math.max(-1, ...frames.map((f) => f[0]))
  let late = 0
  let never = 0
  const lateBy: number[] = []
  const afterGap: number[] = []
  // A frame is "late" if a higher-numbered frame arrived before it.
  const seenMax: number[] = []
  let m = -1
  for (const [no] of order) {
    seenMax.push(m)
    m = Math.max(m, no)
  }
  const arrivalIdx = new Map<number, number>()
  order.forEach((f, i) => arrivalIdx.set(f[0], i))
  const neverList: number[] = []
  for (let no = 0; no <= maxNo; no++) {
    if (!byNo.has(no)) {
      never++
      neverList.push(no)
      continue
    }
    const i = arrivalIdx.get(no)!
    if (seenMax[i] > no) {
      late++
      // when did no+1 arrive (the first frame after it)?
      const next = byNo.get(no + 1)
      if (next !== undefined) lateBy.push(byNo.get(no)! - next)
    }
  }
  // For each missing/late frame, the time from the last arrival before it was due to the next arrival.
  for (const no of [...neverList]) {
    const prevAt = byNo.get(no - 1)
    const nextNo = [...byNo.keys()].filter((k) => k > no).sort((x, y) => x - y)[0]
    if (prevAt !== undefined && nextNo !== undefined) afterGap.push(byNo.get(nextNo)! - prevAt)
  }
  if (neverList.length) {
    const sl = ss.sentLog as [number, number, number, number, number][]
    const desc = (no: number) => {
      const r = sl[no]
      return r ? `#${no}${r[2] ? 'K' : 'd'} ${r[3]}B @${((r[1] - t0) / 1000).toFixed(2)}s rx=${byNo.has(no) ? 'y' : 'N'}` : `#${no}?`
    }
    for (const no of neverList.slice(0, 8)) console.log(`  missing frame: ${[no - 2, no - 1, no, no + 1, no + 2].map(desc).join(' | ')}`)
  }
  let maxFrameGap = 0
  for (let i = 1; i < order.length; i++) if (order[i][1] - t0 < seconds * 1000) maxFrameGap = Math.max(maxFrameGap, order[i][1] - order[i - 1][1])
  lateBy.sort((x, y) => x - y)
  console.log(
    `carrier frames: received ${frames.length} of ${maxNo + 1} (key ${rs.key}, delta ${rs.delta}); recovered late (out of order) ${late}, late by p50 ${pct(lateBy, 50).toFixed(0)} ms max ${pct(lateBy, 100).toFixed(0)} ms; never arrived ${never}${neverList.length ? ` (first: ${neverList.slice(0, 10).join(',')})` : ''}; longest gap between any carrier frames ${Math.round(maxFrameGap)} ms`,
  )
  console.log(`head of line: ${late + never === 0 ? 'no carrier frame went missing' : maxFrameGap < 1000 ? `frames kept arriving while ${late + never} were missing/late (longest inter-frame gap ${Math.round(maxFrameGap)} ms)` : `STALL: longest inter-frame gap ${Math.round(maxFrameGap)} ms`}${afterGap.length ? `; gap around never-arrived frames p50 ${median(afterGap).toFixed(0)} ms` : ''}`)

  const pick = (o: Any, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
  console.log(
    `inbound-rtp: ${JSON.stringify(pick(recv.inb, ['nackCount', 'pliCount', 'firCount', 'framesDropped', 'packetsLost', 'keyFramesDecoded', 'framesReceived', 'framesDecoded', 'packetsReceived', 'retransmittedPacketsReceived', 'bytesReceived', 'jitterBufferDelay', 'jitterBufferEmittedCount', 'framesAssembledFromMultiplePackets']))}`,
  )
  console.log(
    `outbound-rtp: ${JSON.stringify(pick(sender.out, ['nackCount', 'pliCount', 'firCount', 'framesEncoded', 'framesSent', 'keyFramesEncoded', 'packetsSent', 'retransmittedPacketsSent', 'retransmittedBytesSent', 'bytesSent', 'targetBitrate', 'qualityLimitationReason', 'qualityLimitationDurations', 'totalPacketSendDelay', 'encoderImplementation', 'frameWidth', 'frameHeight', 'framesPerSecond', 'hugeFramesSent']))}`,
  )
  console.log(`remote-inbound-rtp: ${JSON.stringify(pick(sender.rem, ['packetsLost', 'fractionLost', 'roundTripTime', 'jitter']))}`)
  console.log(
    `SUMMARY rtp avgMbps=${((totalBytes * 8) / seconds / 1e6).toFixed(2)} medMbps=${median(active).toFixed(2)} med2ndHalf=${median(secondHalf).toFixed(2)} maxGapMs=${Math.round(gaps[0]?.ms ?? NaN)} p50=${pct(lat, 50).toFixed(0)} p95=${pct(lat, 95).toFixed(0)} lost=${lost} corrupt=${rs.corrupt} dup=${dup} framesNever=${never} framesLate=${late} maxFrameGap=${Math.round(maxFrameGap)} lastEst=${((est.at(-1)?.[1] ?? 0) / 1e6).toFixed(2)} nack=${recv.inb.nackCount} pli=${recv.inb.pliCount} fir=${recv.inb.firCount}`,
  )
})
