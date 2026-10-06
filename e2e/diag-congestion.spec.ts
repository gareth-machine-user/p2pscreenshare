import { writeFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { closeContexts, openHost, openViewer, viewerSnapshot, waitFor } from './helpers'
import { blockMainThreadExpr, DIAG_PRESETS, formatTimeline, hostSampleExpr, injectStallExpr, INSTALL_LAG, viewerSampleExpr, type DiagRow } from './diag'

// Opt-in diagnostic (E2E_DIAG=1): a presenter and one viewer on this machine, no upload cap, at a
// high quality preset, with a high-entropy test pattern (the encoder runs at its full bitrate).
// Samples both pages every second and prints a timeline of the congestion controller's inputs and
// decisions, so a bitrate cut between two local tabs (where the network can't be the bottleneck)
// can be traced to what fired it.
//
//   E2E_DIAG=1 DIAG_PRESET=ultra DIAG_SECONDS=75 DIAG_OUT=/tmp/diag.json npx playwright test diag-congestion
//
// Presets (e2e/diag.ts): ultra (1080p 16 Mbps), hi (1080p 8 Mbps), 4k (2160p 20 Mbps), auto (1080p
// 2.5 Mbps, Auto quality). DIAG_PATTERN=bars: the plain test pattern (~2 Mbps whatever the
// preset); bursty: still, with a burst of motion every 4 s (a mostly static screen).
// DIAG_STALL=lane,ms,everyMs emulates SCTP association stalls on one presenter connection;
// DIAG_BLOCK=ms,everyMs blocks the presenter's main thread.
// Playwright keeps every page visible; tools/diag-tabs.ts runs the same with real background tabs.

test.afterEach(closeContexts)

test('diagnostic: congestion between two local tabs', async ({ browser }) => {
  test.skip(!process.env.E2E_DIAG, 'opt-in diagnostic (E2E_DIAG=1)')
  const seconds = Number(process.env.DIAG_SECONDS ?? 75)
  const presetName = process.env.DIAG_PRESET ?? 'ultra'
  const preset = DIAG_PRESETS[presetName]
  test.setTimeout((seconds + 120) * 1000)
  const seed = `e2e-diag-${Date.now()}`
  // No upload cap (openHost's default cap would be the bottleneck).
  const host = await openHost(browser, seed, {
    k: 4,
    m: 1,
    bitrate: preset.bitrate,
    res: preset.res,
    up: null,
    pattern: process.env.DIAG_PATTERN === 'bars' ? undefined : process.env.DIAG_PATTERN === 'bursty' ? 'bursty' : 'busy',
    autoQuality: presetName === 'auto',
  })
  const viewer = await openViewer(browser, seed, 'v')
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 60_000, 'viewer playing')
  const viewerId = (await viewerSnapshot(viewer)).id
  const hostId = await host.evaluate(() => window.__p2p!.selfId)
  await host.evaluate(INSTALL_LAG)
  await viewer.evaluate(INSTALL_LAG)
  // DIAG_STALL=lane,ms,everyMs: emulate association stalls on one of the presenter's connections.
  if (process.env.DIAG_STALL) {
    const [lane, ms, every] = process.env.DIAG_STALL.split(',').map(Number)
    await waitFor(() => host.evaluate<boolean>(injectStallExpr(viewerId, lane, ms, every)), (ok) => ok, 20_000, `lane ${lane} to stall`)
  }

  // DIAG_BLOCK=ms,everyMs: block the presenter's main thread (an overloaded computer).
  if (process.env.DIAG_BLOCK) {
    const [ms, every] = process.env.DIAG_BLOCK.split(',').map(Number)
    await host.evaluate(blockMainThreadExpr(ms, every))
  }
  const rows: DiagRow[] = []
  const t0 = Date.now()
  for (let i = 0; i < seconds; i++) {
    const tick = Date.now()
    const [h, v]: any[] = await Promise.all([host.evaluate(hostSampleExpr(viewerId)), viewer.evaluate(viewerSampleExpr(hostId))])
    const prev = rows.at(-1)
    rows.push({ t: Math.round((Date.now() - t0) / 100) / 10, h, v })
    if (prev && h.kbps !== prev.h.kbps) console.log(`[${rows.at(-1)!.t}s] bitrate ${prev.h.kbps} -> ${h.kbps}: ${h.ccReason}`)
    if (h.localLoad && !prev?.h.localLoad) console.log(`[${rows.at(-1)!.t}s] local load: ${JSON.stringify(h.localLoad)}`)
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - tick))))
  }
  console.log(`preset ${presetName} (${preset.bitrate} kbps ${preset.res}), ${seconds} s`)
  console.log(formatTimeline(rows))
  if (process.env.DIAG_OUT) writeFileSync(process.env.DIAG_OUT, JSON.stringify({ preset: presetName, rows }, null, 1))
})
