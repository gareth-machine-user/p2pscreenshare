// Shared by the congestion diagnostics (e2e/diag-congestion.spec.ts, tools/diag-tabs.ts): what to
// sample from a presenter and a viewer page each second, and the timeline printed from it. The
// samplers are page-side expressions (strings), so they work through Playwright and raw CDP alike.

type Any = any

export const DIAG_PRESETS: Record<string, { bitrate: number; res: string }> = {
  ultra: { bitrate: 16_000, res: '1920x1080' },
  hi: { bitrate: 8000, res: '1920x1080' },
  '4k': { bitrate: 20_000, res: '3840x2160' },
  auto: { bitrate: 2500, res: '1920x1080' },
}

/** Installs a main-thread lag sampler on the page: a 50 ms interval's lateness, and rAF gaps. */
export const INSTALL_LAG = `(() => {
  const w = window
  if (w.__lag) return true
  w.__lag = { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  let expect = performance.now() + 50
  setInterval(() => {
    const now = performance.now()
    const late = Math.max(0, now - expect)
    w.__lag.maxMs = Math.max(w.__lag.maxMs, late)
    w.__lag.sumMs += late
    w.__lag.n++
    expect = now + 50
  }, 50)
  let lastRaf = performance.now()
  const raf = () => {
    const now = performance.now()
    w.__lag.rafMaxGap = Math.max(w.__lag.rafMaxGap, now - lastRaf)
    lastRaf = now
    requestAnimationFrame(raf)
  }
  requestAnimationFrame(raf)
  // Peak send buffer per connection (sampled every 10 ms; the 1 s samples miss bursts).
  w.__bufPeak = new Map()
  setInterval(() => {
    const p = w.__p2p
    if (!p) return
    for (const id of p.mesh.conns.keys()) for (const { lane, conn } of p.mesh.connectionsOf(id)) {
      const k = id + ':' + lane
      w.__bufPeak.set(k, Math.max(w.__bufPeak.get(k) || 0, conn.bufferedAmount))
    }
  }, 10)
  return true
})()`

const TAKE_LAG = `(() => {
  const w = window
  const l = w.__lag || { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  const out = { maxMs: Math.round(l.maxMs), avgMs: l.n ? Math.round(l.sumMs / l.n) : 0, ticks: l.n, rafMaxGap: Math.round(l.rafMaxGap), visible: document.visibilityState }
  w.__lag = { maxMs: 0, sumMs: 0, n: 0, rafMaxGap: 0 }
  return out
})()`

/** One presenter sample (page-side expression), for its link to `viewerId`. */
export function hostSampleExpr(viewerId: string): string {
  return `(async () => {
    const vid = ${JSON.stringify(viewerId)}
    const p = window.__p2p
    const full = p.publishing && p.publishing.full
    const u = p.uplink.stats
    const pairStats = async (pc) => {
      if (!pc) return null
      let out = null
      ;(await pc.getStats()).forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') out = { pSent: r.packetsSent, discarded: r.packetsDiscardedOnSend ?? null, bytesSent: r.bytesSent }
      })
      return out
    }
    const conns = p.mesh.connectionsOf(vid)
    const pairs = await Promise.all(conns.map(({ conn }) => pairStats(conn.pc).catch(() => null)))
    const lanes = conns.map(({ lane, conn }, i) => ({
      lane,
      pair: pairs[i],
      peak: window.__bufPeak ? (window.__bufPeak.get(vid + ':' + lane) || 0) : null,
      buf: conn.bufferedAmount,
      binBuf: conn.bin ? conn.bin.bufferedAmount : null,
      ctlBuf: conn.ctl ? conn.ctl.bufferedAmount : null,
      sent: conn.bytesSent,
      q: p.uplink.queued(conn),
      ice: conn.pc ? conn.pc.iceConnectionState : null,
    }))
    const out = {
      kbps: full ? full.kbps : null,
      ceiling: p.publishing ? p.publishing.ceilingKbps : null,
      ccReason: p.ccReason,
      clamp: p.bitrateClamp(),
      full: p.uplinkFull,
      localLoad: p.localLoad ?? null,
      link: p.linkRates.get(vid) || null,
      path: p.pathQueue.get(vid) || null,
      linkStats: p.linkStatsFor(vid),
      lanes,
      up: p.uplinkStatsNow,
      raw: { sent: u.sentBytes, drops: [...u.droppedByLayer], bg: u.droppedBackground, rep: u.droppedReplay, stalls: u.bufferStalls, queued: u.queuedBytes, fail: u.sendFailed },
      probe: p.capacity.probeKbps,
      est: p.capacity.estimateKbps,
      obsCap: p.capacity.observedCapKbps,
      lastProbeAt: p.uploadProbe ? p.uploadProbe.lastProbeAt : null,
      enc: p.encoderStatsNow,
      now: performance.now(),
      lag: ${TAKE_LAG},
    }
    if (window.__bufPeak) window.__bufPeak.clear()
    return out
  })()`
}

/** One viewer sample (page-side expression), for its link from `hostId`. */
export function viewerSampleExpr(hostId: string): string {
  return `(() => {
    const p = window.__p2p
    const d = p.debugViewer()
    const sub = p.stageSub
    const lanes = p.mesh.connectionsOf(${JSON.stringify(hostId)}).map(({ lane, conn }) => ({ lane, recv: conn.bytesReceived }))
    return { fps: d.fps, latencyMs: d.latencyMs, bufferMs: d.bufferMs, decoded: d.decoded, dropped: d.dropped, loss: sub ? sub.loss : null, lanes, now: performance.now(), lag: ${TAKE_LAG} }
  })()`
}

export interface DiagRow {
  t: number
  h: Any
  v: Any
}

/** The per-second table (deltas of cumulative counters) and a summary line. */
export function formatTimeline(rows: DiagRow[]): string {
  const lines: string[] = []
  lines.push('t     kbps  enc   upKbps qMs  stall drop(t0,t1,t2) full     link(q,d,c)      rtt(l0/l1)      peakBuf(KB)   discards  laneTx(kB/s)  rx(kB/s)    fps lat  lagH lagV vis')
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]
    const b = rows[i]
    const dt = (b.h.now - a.h.now) / 1000
    const dtv = (b.v.now - a.v.now) / 1000
    const tx = b.h.lanes.map((l: Any) => {
      const pl = a.h.lanes.find((x: Any) => x.lane === l.lane)
      return pl ? Math.round((l.sent - pl.sent) / 1000 / dt) : '-'
    })
    const rx = b.v.lanes.map((l: Any) => {
      const pl = a.v.lanes.find((x: Any) => x.lane === l.lane)
      return pl ? Math.round((l.recv - pl.recv) / 1000 / dtv) : '-'
    })
    const drops = b.h.raw.drops.map((d: number, j: number) => d - a.h.raw.drops[j]).slice(0, 3)
    const rtt = b.h.linkStats.map((s: Any) => `${s.rttMs ?? '?'}${s.fresh ? '' : '*'}`).join('/')
    const full = b.h.full ? `${b.h.full.signal}` : '-'
    const link = b.h.link ? `${b.h.link.queueMs},${b.h.link.drops},${b.h.link.congested ? 'C' : '-'}${b.h.link.stalled ? 'S' : ''}` : '-'
    lines.push(
      [
        String(b.t).padEnd(5),
        String(b.h.kbps).padEnd(5),
        String(b.h.enc?.kbps ?? '-').padEnd(5),
        String(b.h.up?.kbps ?? '-').padEnd(6),
        String(b.h.up?.queueMs ?? '-').padEnd(4),
        String(b.h.raw.stalls - a.h.raw.stalls).padEnd(5),
        drops.join(',').padEnd(14),
        full.padEnd(8),
        link.padEnd(16),
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
  const cuts = rows.filter((r, i) => i > 0 && r.h.kbps < rows[i - 1].h.kbps).length
  const fullN = rows.filter((r) => r.h.full).length
  const congested = rows.filter((r) => r.h.link?.congested).length
  const stalled = rows.filter((r) => r.h.link?.stalled).length
  const local = rows.filter((r) => r.h.localLoad).length
  const lowestKbps = Math.min(...rows.map((r) => r.h.kbps ?? Infinity))
  const last = rows.at(-1)
  lines.push(
    `summary: cuts=${cuts} fullSamples=${fullN}/${rows.length} congestedSamples=${congested} stalledSamples=${stalled} localLoadSamples=${local} lowestKbps=${lowestKbps} finalKbps=${last?.h.kbps} probe=${Math.round(last?.h.probe ?? 0)} est=${Math.round(last?.h.est ?? 0)}`,
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
  return `(() => {
    const p = window.__p2p
    const c = p.mesh.connectionsOf(${JSON.stringify(viewerId)}).find((x) => x.lane === ${lane})
    if (!c) return false
    const conn = c.conn
    const ch = conn.media
    const held = []
    let heldBytes = 0
    let stalled = false
    const realSend = ch.send.bind(ch)
    ch.send = (d) => { if (stalled) { held.push(d); heldBytes += d.byteLength } else realSend(d) }
    const desc = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount')
    Object.defineProperty(ch, 'bufferedAmount', { get: () => desc.get.call(ch) + heldBytes })
    window.__stalls = []
    setInterval(() => {
      stalled = true
      window.__stalls.push(performance.now())
      setTimeout(() => {
        stalled = false
        for (const d of held.splice(0)) realSend(d)
        heldBytes = 0
        ch.dispatchEvent(new Event('bufferedamountlow'))
      }, ${ms})
    }, ${everyMs})
    return true
  })()`
}

/** Blocks the page's main thread for `ms` every `everyMs` (an overloaded computer). */
export function blockMainThreadExpr(ms: number, everyMs: number): string {
  return `(() => {
    setInterval(() => { const t = performance.now(); while (performance.now() - t < ${ms}) {} }, ${everyMs})
    return true
  })()`
}
