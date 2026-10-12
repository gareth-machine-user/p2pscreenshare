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
    __transit?: { key: boolean; audio: boolean; ms: number; bytes: number }[]
    __encKeys?: number[]
  }
}

/** A mesh connection as it is in the page (PairConn hides the peer connection). */
type PageConn = PairConn & Partial<Pick<MeshConn, 'pc' | 'ctl' | 'probeLink'>>

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
    for (const id of p.mesh.conns.keys()) {
      const conn = p.mesh.linkFor(id)
      if (conn) peak.set(id, Math.max(peak.get(id) || 0, conn.bufferedAmount))
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
  type Pair = { pSent: number; discarded: number | null; bytesSent: number; est: number | null; frames?: number }
  const pairStats = async (pc: RTCPeerConnection | undefined): Promise<Pair | null> => {
    if (!pc) return null
    let out: Pair | null = null
    ;(await pc.getStats()).forEach((r) => {
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded')
        out = { pSent: r.packetsSent, discarded: r.packetsDiscardedOnSend ?? null, bytesSent: r.bytesSent, est: r.availableOutgoingBitrate ?? null }
    })
    // The carrier's frames sent (its outbound video stream).
    ;(await pc.getStats()).forEach((r) => {
      if (out && r.type === 'outbound-rtp' && r.kind === 'video') out.frames = r.framesSent
    })
    return out
  }
  // How long keyframes take to encode (capture to encoded), by wrapping the video pipeline's output.
  const video = (p.publishing as Any)?.video as { onFrame: (f: Any) => void; __diag?: boolean } | undefined
  if (video && !video.__diag) {
    video.__diag = true
    const emit = video.onFrame
    video.onFrame = (f) => {
      if (f.key) (window.__encKeys ??= []).push(Math.round(performance.timeOrigin + performance.now() - f.captureTime))
      emit(f)
    }
  }
  const encKeys = window.__encKeys ?? []
  window.__encKeys = []
  const c = p.mesh.linkFor(vid) as PageConn | undefined
  const pair = c ? await pairStats(c.pc).catch(() => null) : null
  const conn = c
    ? {
        pair,
        peak: window.__bufPeak ? window.__bufPeak.get(vid) || 0 : null,
        buf: c.bufferedAmount,
        padBuf: c.probeLink ? c.probeLink.bufferedAmount : null,
        ctlBuf: c.ctl ? c.ctl.bufferedAmount : null,
        sent: pair ? pair.bytesSent : null,
        q: p.uplink.queued(c),
        ice: c.pc ? c.pc.iceConnectionState : null,
      }
    : null
  const out = {
    kbps: full ? full.kbps : null,
    ceiling: p.publishing ? p.publishing.ceilingKbps : null,
    rate: p.rateStatus(),
    localLoad: p.localLoad ?? null,
    link: p.linkRate(vid),
    peerCap: p.peerCapacity(vid),
    linkStats: p.linkStatsFor(vid),
    conn,
    up: p.uplinkStatsNow,
    raw: { sent: u.sentBytes, drops: [...u.droppedByLayer], bg: u.droppedBackground, rep: u.droppedReplay, stalls: u.bufferStalls, queued: u.queuedBytes, fail: u.sendFailed, qSum: u.queueDelaySum, qN: u.queueDelayN },
    cap: p.capacity.uplinkKbps,
    lastProbeAt: p.lastProbeAt,
    enc: p.encoderStatsNow,
    encKeys,
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
  const c = p.mesh.linkFor(hostId) as PageConn | undefined
  const recv = c?.pc ? await recvOf(c.pc).catch(() => null) : null
  // Each frame's transit (completion here - capture there, through the clock offset when known),
  // by wrapping the stage player's push (installed on the first sample, again for a new player).
  const player = sub?.player as (NonNullable<typeof sub>['player'] & { __diag?: boolean }) | undefined
  if (player && !player.__diag) {
    player.__diag = true
    const push = player.push.bind(player)
    player.push = (f) => {
      if (!f.replay) {
        const ms = f.completedAt + (player.clockOffset ?? 0) - f.captureTime
        ;(window.__transit ??= []).push({ key: f.key, audio: !!f.audio, ms, bytes: f.data.byteLength })
      }
      push(f)
    }
  }
  const tr = window.__transit ?? []
  window.__transit = []
  const vid = tr.filter((x) => !x.audio && !x.key).map((x) => x.ms).sort((a, b) => a - b)
  const q = (a: number[], f: number) => (a.length ? Math.round(a[Math.min(a.length - 1, Math.floor(a.length * f))]) : null)
  const keys = tr.filter((x) => x.key).map((x) => ({ ms: Math.round(x.ms), kb: Math.round(x.bytes / 1024) }))
  const aud = tr.filter((x) => x.audio).map((x) => x.ms).sort((a, b) => a - b)
  const transit = { min: q(vid, 0), med: q(vid, 0.5), q99: q(vid, 0.99), max: q(vid, 1), keys, audMed: q(aud, 0.5), audMax: q(aud, 1) }
  const ps = sub?.player.stats
  // Frames that came after their play time, or were skipped waiting for a missing one (stalls).
  const late = ps ? ps.late + ps.skipped : null
  return { fps: d.fps, latencyMs: d.latencyMs, bufferMs: d.bufferMs, decoded: d.decoded, dropped: d.dropped, late, loss: sub ? sub.loss : null, recv, transit, now: performance.now(), lag: lag() }
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
  lines.push('t     kbps  limit    enc   upKbps qMs  q1s  P stall drop(t0,t1,t2) capUp  capPeer   link(del,B,S) est    rtt    peakBuf(KB) discards tx(kB/s) rx(kB/s) fps lat  buf  tMin tMed t99  tMax key(ms/KB) kEnc   lagH lagV vis  cfps')
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    const dt = (b.h.now - a.h.now) / 1000
    const dtv = (b.v.now - a.v.now) / 1000
    const hc = b.h.conn
    const pc = a.h.conn
    const tx = hc?.sent != null && pc?.sent != null ? Math.round((hc.sent - pc.sent) / 1000 / dt) : '-'
    const rx = b.v.recv != null && a.v.recv != null ? Math.round((b.v.recv - a.v.recv) / 1000 / dtv) : '-'
    const drops = b.h.raw.drops.map((d: number, j: number) => d - a.h.raw.drops[j]).slice(0, 3)
    const ls = b.h.linkStats
    const rtt = ls ? `${ls.rttMs ?? '?'}${ls.fresh ? '' : '*'}` : '-'
    const est = hc?.pair?.est != null ? String(Math.round(hc.pair.est / 1000)) : '-'
    const limit = b.h.rate?.limit ?? '-'
    const capUp = b.h.cap == null ? '-' : String(Math.round(b.h.cap))
    const capPeer = b.h.peerCap?.kbps == null ? '-' : `${Math.round(b.h.peerCap.kbps)}${b.h.peerCap.bound ? '!' : ''}`
    const link = ls ? `${ls.deliveredKbps ?? '-'}${ls.backlogged ? 'B' : ''}${ls.stalled ? 'S' : ''}` : '-'
    const discards = hc?.pair?.discarded != null && pc?.pair?.discarded != null ? hc.pair.discarded - pc.pair.discarded : '-'
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
        link.padEnd(13),
        est.padEnd(6),
        rtt.padEnd(6),
        String(hc ? Math.round((hc.peak ?? hc.buf) / 1024) : '-').padEnd(11),
        String(discards).padEnd(8),
        String(tx).padEnd(8),
        String(rx).padEnd(8),
        String(b.v.fps).padEnd(3),
        String(b.v.latencyMs == null ? '-' : Math.round(b.v.latencyMs)).padEnd(4),
        String(Math.round(b.v.bufferMs)).padEnd(4),
        String(b.v.transit.min ?? '-').padEnd(4),
        String(b.v.transit.med ?? '-').padEnd(4),
        String(b.v.transit.q99 ?? '-').padEnd(4),
        String(b.v.transit.max ?? '-').padEnd(4),
        (b.v.transit.keys.map((k) => `${k.ms}/${k.kb}`).join(',') || '-').padEnd(11),
        (b.h.encKeys.join(',') || '-').padEnd(6),
        `${b.h.lag.maxMs}`.padEnd(4),
        `${b.v.lag.maxMs}`.padEnd(4),
        `${b.h.lag.visible[0]}${b.v.lag.visible[0]}`.padEnd(4),
        String(hc?.pair?.frames != null && pc?.pair?.frames != null ? Math.round((hc.pair.frames - pc.pair.frames) / dt) : '-'),
      ].join(' '),
    )
  }
  const cuts = rows.filter((r, i) => i > 0 && (r.h.kbps ?? 0) < (rows[i - 1].h.kbps ?? 0)).length
  const limited = rows.filter((r) => r.h.rate && r.h.rate.limit !== 'chosen').length
  const backlogged = rows.filter((r) => r.h.link?.backlogged).length
  const stalled = rows.filter((r) => r.h.linkStats?.stalled).length
  const probes = new Set(rows.map((r) => r.h.lastProbeAt).filter((x) => x != null && x > -Infinity)).size
  const local = rows.filter((r) => r.h.localLoad).length
  const lowestKbps = Math.min(...rows.map((r) => r.h.kbps ?? Infinity))
  const last = rows.at(-1)
  lines.push(
    `summary: cuts=${cuts} limitedSamples=${limited}/${rows.length} backloggedSamples=${backlogged} stalledSamples=${stalled} localLoadSamples=${local} probes=${probes} lowestKbps=${lowestKbps} finalKbps=${last?.h.kbps} uplinkCap=${Math.round(last?.h.cap ?? 0)} peerCap=${Math.round(last?.h.peerCap?.kbps ?? 0)}`,
  )
  lines.push(`encoder last: ${JSON.stringify(last?.h.enc)}`)
  // The second half of the run (past the jitter buffer's warmup): medians of the per-second values.
  const tail = rows.slice(Math.floor(rows.length / 2))
  const med = (xs: (number | null | undefined)[]) => {
    const a = xs.filter((x): x is number => x != null).sort((x, y) => x - y)
    return a.length ? Math.round(a[Math.floor(a.length / 2)]) : null
  }
  const txs = tail.slice(1).map((r, i) => (r.h.conn?.sent != null && tail[i].h.conn?.sent != null ? ((r.h.conn.sent - tail[i].h.conn!.sent!) * 8) / (r.h.now - tail[i].h.now) : null))
  const lateIn = (rs: DiagRow[]) => (rs.length > 1 && rs[0].v.late != null && rs.at(-1)!.v.late != null ? rs.at(-1)!.v.late! - rs[0].v.late! : null)
  lines.push(
    `second half: late=${lateIn(tail)} (whole run ${lateIn(rows)}) lat=${med(tail.map((r) => r.v.latencyMs))} buf=${med(tail.map((r) => r.v.bufferMs))} tMin=${med(tail.map((r) => r.v.transit.min))} tMed=${med(tail.map((r) => r.v.transit.med))} audMed=${med(tail.map((r) => r.v.transit.audMed))} audMax=${med(tail.map((r) => r.v.transit.audMax))} t99=${med(tail.map((r) => r.v.transit.q99))} fps=${med(tail.map((r) => r.v.fps))} kbps=${med(tail.map((r) => r.h.kbps))} txKbps=${med(txs)} keyTransit=${tail.flatMap((r) => r.v.transit.keys.map((k) => k.ms)).join(',')}`,
  )
  return lines.join('\n')
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
