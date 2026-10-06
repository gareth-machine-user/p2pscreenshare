import { execSync } from 'node:child_process'
import { test, type Page } from '@playwright/test'
import { closeContexts, newContext } from './helpers'

// Opt-in diagnostic (E2E_DIAG=1): does keeping a lot buffered on one data channel stall the whole
// SCTP association in Chromium? Two pages (separate renderers), one RTCPeerConnection each, with
// the app's channel layout (unordered partially reliable `media`, reliable `ctl`, reliable `bin`).
// The sender keeps DIAG_BUF bytes buffered on DIAG_CH (bin or media) in DIAG_CHUNK messages for
// DIAG_SECONDS, and pings on ctl every 50 ms; the receiver logs when each message arrives. Prints
// the longest delivery gaps per channel and the per-100 ms throughput around them.

test.afterEach(closeContexts)

type Any = any

async function page(browser: Any): Promise<Page> {
  const ctx = await newContext(browser)
  const p = await ctx.newPage()
  await p.goto('about:blank')
  return p
}

const SETUP = `(() => {
  const pc = new RTCPeerConnection({ iceServers: [] })
  const media = pc.createDataChannel('media', { negotiated: true, id: 0, ordered: false, maxPacketLifeTime: 3000 })
  const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 1, ordered: true })
  const bin = pc.createDataChannel('bin', { negotiated: true, id: 2, ordered: true })
  for (const c of [media, ctl, bin]) c.binaryType = 'arraybuffer'
  window.__t = { pc, ch: { media, ctl, bin }, log: { media: [], ctl: [], bin: [] }, bytes: { media: 0, ctl: 0, bin: 0 } }
  for (const [name, c] of Object.entries(window.__t.ch)) c.onmessage = (e) => {
    const n = typeof e.data === 'string' ? e.data.length : e.data.byteLength
    window.__t.bytes[name] += n
    window.__t.log[name].push([performance.now(), n])
  }
  pc.onicecandidate = () => {}
  return true
})()`

async function connect(a: Page, b: Page): Promise<void> {
  await a.evaluate(SETUP)
  await b.evaluate(SETUP)
  const gather = `new Promise((r) => { const pc = window.__t.pc; if (pc.iceGatheringState === 'complete') r(pc.localDescription.sdp); pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(pc.localDescription.sdp) })`
  const offer = await a.evaluate(`(async () => { const pc = window.__t.pc; await pc.setLocalDescription(await pc.createOffer()); return await ${gather} })()`)
  const answer = await b.evaluate(
    `(async () => { const pc = window.__t.pc; await pc.setRemoteDescription({ type: 'offer', sdp: ${JSON.stringify(offer)} }); await pc.setLocalDescription(await pc.createAnswer()); return await ${gather} })()`,
  )
  await a.evaluate(`window.__t.pc.setRemoteDescription({ type: 'answer', sdp: ${JSON.stringify(answer)} })`)
  await a.waitForFunction(`window.__t.ch.ctl.readyState === 'open' && window.__t.ch.bin.readyState === 'open' && window.__t.ch.media.readyState === 'open'`)
}

test('diagnostic: SCTP association stalls under a deep send buffer', async ({ browser }) => {
  test.skip(!process.env.E2E_DIAG, 'opt-in diagnostic (E2E_DIAG=1)')
  const seconds = Number(process.env.DIAG_SECONDS ?? 20)
  const buf = Number(process.env.DIAG_BUF ?? 1024 * 1024)
  const chunk = Number(process.env.DIAG_CHUNK ?? 16 * 1024)
  const chName = process.env.DIAG_CH ?? 'bin'
  test.setTimeout((seconds + 60) * 1000)
  const a = await page(browser)
  const b = await page(browser)
  await connect(a, b)
  const sending: Promise<Any> = a.evaluate(
    `(async () => {
      const t = window.__t
      const ch = t.ch[${JSON.stringify(chName)}]
      ch.bufferedAmountLowThreshold = Math.floor(${buf} / 2)
      const data = new Uint8Array(${chunk})
      let sent = 0
      const fill = () => { while (ch.bufferedAmount < ${buf}) { ch.send(data); sent += ${chunk} } }
      ch.onbufferedamountlow = fill
      const bufLog = []
      let seq = 0
      const ping = setInterval(() => { t.ch.ctl.send(JSON.stringify({ seq: seq++ })); bufLog.push([performance.now(), ch.bufferedAmount, t.ch.ctl.bufferedAmount]) }, 50)
      const backstop = setInterval(fill, 20)
      fill()
      await new Promise((r) => setTimeout(r, ${seconds * 1000}))
      clearInterval(ping); clearInterval(backstop); ch.onbufferedamountlow = null
      return { sent, bufLog, start: bufLog[0]?.[0] }
    })()`,
  )
  // The browsers' UDP sockets mid-transfer: their send/receive buffer sizes and drops (Linux `ss`).
  if (process.env.DIAG_SS) {
    await new Promise((r) => setTimeout(r, (seconds * 1000) / 2))
    console.log(execSync('ss -uapnm 2>/dev/null | grep -A1 chromium || true').toString())
  }
  const sent = await sending
  await new Promise((r) => setTimeout(r, 2000))
  const recv: Any = await b.evaluate(`(() => ({ log: window.__t.log, bytes: window.__t.bytes }))()`)
  const stats: Any = await a.evaluate(`(async () => { const out = []; (await window.__t.pc.getStats()).forEach((r) => { if (r.type === 'candidate-pair' && r.nominated) out.push({ rtt: r.currentRoundTripTime, sent: r.bytesSent, recv: r.bytesReceived, pSent: r.packetsSent, pRecv: r.packetsReceived, discarded: r.packetsDiscardedOnSend }); if (r.type === 'data-channel') out.push({ label: r.label, msgsSent: r.messagesSent, bytesSent: r.bytesSent }) }); return out })()`)
  const bstats: Any = await b.evaluate(`(async () => { const out = []; (await window.__t.pc.getStats()).forEach((r) => { if (r.type === 'candidate-pair' && r.nominated) out.push({ pSent: r.packetsSent, pRecv: r.packetsReceived }); if (r.type === 'data-channel') out.push({ label: r.label, msgsRecv: r.messagesReceived, bytesRecv: r.bytesReceived }) }); return out })()`)

  // Receiver clocks are per page; the gaps are what matter.
  const gaps = (log: [number, number][]) => {
    const out: { at: number; gapMs: number }[] = []
    for (let i = 1; i < log.length; i++) out.push({ at: log[i - 1][0], gapMs: log[i][0] - log[i - 1][0] })
    return out.sort((x, y) => y.gapMs - x.gapMs).slice(0, 5)
  }
  console.log(`channel ${chName}, buffer ${buf} B, chunk ${chunk} B, ${seconds} s; sender wrote ${(sent.sent / 1e6).toFixed(1)} MB`)
  console.log(`received: ${JSON.stringify(Object.fromEntries(Object.entries(recv.bytes).map(([k, v]: Any) => [k, (v / 1e6).toFixed(1) + ' MB'])))}`)
  for (const name of [chName, 'ctl']) {
    const log = recv.log[name] as [number, number][]
    const g = gaps(log)
    console.log(`${name}: ${log.length} msgs, longest gaps (ms): ${g.map((x) => Math.round(x.gapMs)).join(', ')}`)
  }
  // Throughput per 500 ms on the bulk channel, receiver side.
  const log = recv.log[chName] as [number, number][]
  if (log.length) {
    const t0 = log[0][0]
    const bins: number[] = []
    for (const [t, n] of log) bins[Math.floor((t - t0) / 500)] = (bins[Math.floor((t - t0) / 500)] ?? 0) + n
    console.log(`${chName} MB per 500 ms: ${Array.from(bins, (x) => ((x ?? 0) / 1e6).toFixed(1)).join(' ')}`)
  }
  const maxBuf = Math.max(...sent.bufLog.map((x: number[]) => x[1]))
  const maxCtlBuf = Math.max(...sent.bufLog.map((x: number[]) => x[2]))
  console.log(`sender max bufferedAmount: bulk ${maxBuf}, ctl ${maxCtlBuf}`)
  console.log('sender stats', JSON.stringify(stats))
  console.log('receiver stats', JSON.stringify(bstats))
})
