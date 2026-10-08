// Shared by the congestion diagnostics (e2e/diag-congestion.spec.ts, tools/diag-tabs.ts): what to
// sample from a presenter and a viewer page each second, and the timeline printed from it. The
// samplers are typed page functions, exported as expressions (strings) so they work through
// Playwright and raw CDP alike.

import type { PairConn } from '../src/mesh/dataConn'
import type { MeshConn } from '../src/mesh/meshConn'

type Any = any

export const DIAG_PRESETS: Record<string, { bitrate: number; res: string }> = {
  ultra: { bitrate: 16_000, res: '1920x1080' },
  hi: { bitrate: 8000, res: '1920x1080' },
  '4k': { bitrate: 20_000, res: '3840x2160' },
  auto: { bitrate: 2500, res: '1920x1080' },
}

interface Lag {
  maxMs: number
  sumMs: number
  n: number
  rafMaxGap: number
}

// Diagnostics-only page globals (the app's own are in e2e/global.d.ts).
declare global {
  interface Window {
    __lag?: Lag
    __bufPeak?: Map<string, number>
    __stalls?: number[]
  }
}

/** A mesh or lane connection as it is in the page (PairConn hides the channels). */
type PageConn = PairConn & Partial<Pick<MeshConn, 'pc' | 'media' | 'bin' | 'ctl'>>

/**
 * `fn(...args)` as a page-side expression (a function argument is passed as its source). The page
 * functions below are type-checked against the app, and refer only to their arguments and the
 * page's globals.
 */
function pageExpr<A extends unknown[]>(fn: (...args: A) => unknown, ...args: A): string {
  const src = args.map((a) => (typeof a === 'function' ? `(${a})` : JSON.stringify(a)))
  // tsx (esbuild keepNames) calls __name() inside function bodies; the page has none.
  return `(() => { const __name = (f) => f; return (${fn})(${src.join(', ')}) })()`
}

function installLag(): boolean {
  const w = window
  if (w.__lag) return true
  w.__lag = { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  let expect = performance.now() + 50
  setInterval(() => {
    const l = w.__lag!
    const now = performance.now()
    const late = Math.max(0, now - expect)
    l.maxMs = Math.max(l.maxMs, late)
    l.sumMs += late
    l.n++
    expect = now + 50
  }, 50)
  let lastRaf = performance.now()
  const raf = () => {
    const l = w.__lag!
    const now = performance.now()
    l.rafMaxGap = Math.max(l.rafMaxGap, now - lastRaf)
    lastRaf = now
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
  // Peak send buffer per connection (sampled every 10 ms; the 1 s samples miss bursts).
  const peak = (w.__bufPeak = new Map<string, number>())
  setInterval(() => {
    const p = w.__p2p
    if (!p) return
    for (const id of p.mesh.conns.keys())
      for (const { lane, conn } of p.mesh.connectionsOf(id)) {
        const k = id + ':' + lane
        peak.set(k, Math.max(peak.get(k) || 0, conn.bufferedAmount))
      }
  }, 10)
  return true
}

/** Installs a main-thread lag sampler on the page: a 50 ms interval's lateness, and rAF gaps. */
export const INSTALL_LAG = pageExpr(installLag)

/** The lag since the last take, and resets it (passed into the samplers, which run it last). */
function takeLag() {
  const w = window
  const l = w.__lag || { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  const out = { maxMs: Math.round(l.maxMs), avgMs: l.n ? Math.round(l.sumMs / l.n) : 0, ticks: l.n, rafMaxGap: Math.round(l.rafMaxGap), visible: document.visibilityState }
  w.__lag = { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  return out
}

async function hostSample(vid: string, lag: typeof takeLag) {
  const p = window.__p2p!
  const full = p.publishing && p.publishing.full
  const u = p.uplink.stats
  type Pair = { pSent: number; discarded: number | null; bytesSent: number }
  const pairStats = async (pc: RTCPeerConnection | undefined): Promise<Pair | null> => {
    if (!pc) return null
    let out: Pair | null = null
    ;(await pc.getStats()).forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') out = { pSent: r.packetsSent, discarded: r.packetsDiscardedOnSend ?? null, bytesSent: r.bytesSent }
    })
    return out
  }
  const conns = p.mesh.connectionsOf(vid) as { lane: number; conn: PageConn }[]
  const pairs = await Promise.all(conns.map(({ conn }) => pairStats(conn.pc).catch(() => null)))
  const lanes = conns.map(({ lane, conn }, i) => ({
    lane,
    pair: pairs[i],
    peak: window.__bufPeak ? window.__bufPeak.get(vid + ':' + lane) || 0 : null,
    buf: conn.bufferedAmount,
    binBuf: conn.bin ? conn.bin.bufferedAmount : null,
    ctlBuf: conn.ctl ? conn.ctl.bufferedAmount : null,
    sent: pairs[i] ? pairs[i].bytesSent : null,
    q: p.uplink.queued(conn),
    ice: conn.pc ? conn.pc.iceConnectionState : null,
  }))
  const out = {
    kbps: full ? full.kbps : null,
    ceiling: p.publishing ? p.publishing.ceilingKbps : null,
    rate: p.rateStatus(),
    localLoad: p.localLoad ?? null,
    link: p.linkRate(vid),
    peerCap: p.peerCapacity(vid),
    linkStats: p.linkStatsFor(vid),
    lanes,
    up: p.uplinkStatsNow,
    raw: { sent: u.sentBytes, drops: [...u.droppedByLayer], bg: u.droppedBackground, rep: u.droppedReplay, stalls: u.bufferStalls, queued: u.queuedBytes, fail: u.sendFailed, qSum: u.queueDelaySum, qN: u.queueDelayN },
    cap: p.capacity.uplinkKbps,
    lastProbeAt: p.lastProbeAt,
    enc: p.encoderStatsNow,
    now: performance.now(),
    lag: lag(),
  }
  if (window.__bufPeak) window.__bufPeak.clear()
  return out
}

/** One presenter sample (page-side expression), for its link to `viewerId`. */
export function hostSampleExpr(viewerId: string): string {
  return pageExpr(hostSample, viewerId, takeLag)
}

async function viewerSample(hostId: string, lag: typeof takeLag) {
  const p = window.__p2p!
  const d = p.debugViewer()
  const sub = p.stageSub
  const recvOf = async (pc: RTCPeerConnection) => {
    let out: number | null = null
    ;(await pc.getStats()).forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') out = r.bytesReceived
    })
    return out
  }
  const conns = p.mesh.connectionsOf(hostId) as { lane: number; conn: PageConn }[]
  const lanes = await Promise.all(conns.map(async ({ lane, conn }) => ({ lane, recv: conn.pc ? await recvOf(conn.pc).catch(() => null) : null })))
  return { fps: d.fps, latencyMs: d.latencyMs, bufferMs: d.bufferMs, decoded: d.decoded, dropped: d.dropped, loss: sub ? sub.loss : null, lanes, now: performance.now(), lag: lag() }
}

/** One viewer sample (page-side expression), for its link from `hostId`. */
export function viewerSampleExpr(hostId: string): string {
  return pageExpr(viewerSample, hostId, takeLag)
}

export interface DiagRow {
  t: number
  h: Awaited<ReturnType<typeof hostSample>>
  v: Awaited<ReturnType<typeof viewerSample>>
}

/** The per-second table (deltas of cumulative counters) and a summary line. */
export function formatTimeline(rows: DiagRow[]): string {
  const lines: string[] = []
  lines.push('t     kbps  limit    enc   upKbps qMs  q1s  P stall drop(t0,t1,t2) capUp  capPeer   lanes(del,B,S)        rtt(l0/l1)      peakBuf(KB)   discards  laneTx(kB/s)  rx(kB/s)    fps lat  lagH lagV vis')
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    const dt = (b.h.now - a.h.now) / 1000
    const dtv = (b.v.now - a.v.now) / 1000
    const tx = b.h.lanes.map((l: Any) => {
      const pl = a.h.lanes.find((x: Any) => x.lane === l.lane)
      return pl ? Math.round((l.sent - (pl.sent ?? 0)) / 1000 / dt) : '-'
    })
    const rx = b.v.lanes.map((l: Any) => {
      const pl = a.v.lanes.find((x: Any) => x.lane === l.lane)
      return pl ? Math.round((l.recv - (pl.recv ?? 0)) / 1000 / dtv) : '-'
    })
    const drops = b.h.raw.drops.map((d: number, j: number) => d - a.h.raw.drops[j]).slice(0, 3)
    const rtt = b.h.linkStats.map((s: Any) => `${s.rttMs ?? '?'}${s.fresh ? '' : '*'}`).join('/')
    const limit = b.h.rate?.limit ?? '-'
    const capUp = b.h.cap == null ? '-' : String(Math.round(b.h.cap))
    const capPeer = b.h.peerCap?.kbps == null ? '-' : `${Math.round(b.h.peerCap.kbps)}${b.h.peerCap.bound ? '!' : ''}`
    const lanes = b.h.linkStats.map((l: Any) => `${l.deliveredKbps ?? '-'}${l.backlogged ? 'B' : ''}${l.stalled ? 'S' : ''}`).join('/')
    lines.push(
      [
        String(b.t).padEnd(5),
        String(b.h.kbps).padEnd(5),
        limit.padEnd(8),
        String(b.h.enc?.kbps ?? '-').padEnd(5),
        String(b.h.up?.kbps ?? '-').padEnd(6),
        String(b.h.up?.queueMs ?? '-').padEnd(4),
        String(b.h.raw.qN > a.h.raw.qN ? Math.round((b.h.raw.qSum - a.h.raw.qSum) / (b.h.raw.qN - a.h.raw.qN)) : '-').padEnd(4),
        b.h.lastProbeAt !== a.h.lastProbeAt ? 'P' : ' ',
        String(b.h.raw.stalls - a.h.raw.stalls).padEnd(5),
        drops.join(',').padEnd(14),
        capUp.padEnd(6),
        capPeer.padEnd(9),
        lanes.padEnd(21),
        rtt.padEnd(15),
        b.h.lanes
          .map((l: Any) => Math.round((l.peak ?? l.buf) / 1024))
          .join('/')
          .padEnd(13),
        b.h.lanes
          .map((l: Any) => {
            const pl = a.h.lanes.find((x: Any) => x.lane === l.lane)
            return l.pair?.discarded != null && pl?.pair?.discarded != null ? l.pair.discarded - pl.pair.discarded : '-'
          })
          .join('/')
          .padEnd(9),
        tx.join('/').padEnd(13),
        rx.join('/').padEnd(11),
        String(b.v.fps).padEnd(3),
        String(b.v.latencyMs == null ? '-' : Math.round(b.v.latencyMs)).padEnd(4),
        `${b.h.lag.maxMs}`.padEnd(4),
        `${b.v.lag.maxMs}`.padEnd(4),
        `${b.h.lag.visible[0]}${b.v.lag.visible[0]}`,
      ].join(' '),
    )
  }
  const cuts = rows.filter((r, i) => i > 0 && (r.h.kbps ?? 0) < (rows[i - 1].h.kbps ?? 0)).length
  const limited = rows.filter((r) => r.h.rate && r.h.rate.limit !== 'chosen').length
  const backlogged = rows.filter((r) => r.h.link?.backlogged).length
  const stalled = rows.filter((r) => r.h.linkStats.some((l: Any) => l.stalled)).length
  const probes = new Set(rows.map((r) => r.h.lastProbeAt).filter((x) => x != null && x > -Infinity)).size
  const local = rows.filter((r) => r.h.localLoad).length
  const lowestKbps = Math.min(...rows.map((r) => r.h.kbps ?? Infinity))
  const last = rows.at(-1)
  lines.push(
    `summary: cuts=${cuts} limitedSamples=${limited}/${rows.length} backloggedSamples=${backlogged} stalledSamples=${stalled} localLoadSamples=${local} probes=${probes} lowestKbps=${lowestKbps} finalKbps=${last?.h.kbps} uplinkCap=${Math.round(last?.h.cap ?? 0)} peerCap=${Math.round(last?.h.peerCap?.kbps ?? 0)}`,
  )
  lines.push(`encoder last: ${JSON.stringify(last?.h.enc)}`)
  return lines.join('\n')
}

/**
 * Emulates an SCTP association stall on the presenter's connection `lane` to `viewerId`: every
 * `everyMs`, for `ms`, what the app sends on it is held back (and counted in its bufferedAmount),
 * then released at once, as when loss recovery by retransmission timeout ends.
 */
export function injectStallExpr(viewerId: string, lane: number, ms: number, everyMs: number): string {
  return pageExpr(injectStall, viewerId, lane, ms, everyMs)
}

function injectStall(viewerId: string, lane: number, ms: number, everyMs: number): boolean {
  const p = window.__p2p!
  const c = (p.mesh.connectionsOf(viewerId) as { lane: number; conn: PageConn }[]).find((x) => x.lane === lane)
  if (!c?.conn.media) return false
  const ch = c.conn.media
  const held: ArrayBufferView<ArrayBuffer>[] = []
  let heldBytes = 0
  let stalled = false
  const realSend = ch.send.bind(ch) as (d: ArrayBufferView<ArrayBuffer>) => void
  ch.send = ((d: ArrayBufferView<ArrayBuffer>) => {
    if (stalled) {
      held.push(d)
      heldBytes += d.byteLength
    } else realSend(d)
  }) as RTCDataChannel['send']
  const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount')!
  Object.defineProperty(ch, 'bufferedAmount', { get: () => desc.get!.call(ch) + heldBytes })
  const stalls: number[] = (window.__stalls = [])
  setInterval(() => {
    stalled = true
    stalls.push(performance.now())
    setTimeout(() => {
      stalled = false
      for (const d of held.splice(0)) realSend(d)
      heldBytes = 0
      ch.dispatchEvent(new Event('bufferedamountlow'))
    }, ms)
  }, everyMs)
  return true
}

/** Blocks the page's main thread for `ms` every `everyMs` (an overloaded computer). */
export function blockMainThreadExpr(ms: number, everyMs: number): string {
  return pageExpr(
    (ms: number, everyMs: number) => {
      setInterval(() => {
        const t = performance.now()
        while (performance.now() - t < ms) {}
      }, everyMs)
      return true
    },
    ms,
    everyMs,
  )
}
