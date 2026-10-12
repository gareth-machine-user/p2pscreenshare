import { writeFileSync } from 'node:fs'
import { test } from '@playwright/test'
import { closeContexts, openHost, openViewer, viewerSnapshot, waitFor } from './helpers'
import { blockMainThreadExpr, DIAG_PRESETS, formatTimeline, hostSampleExpr, INSTALL_LAG, viewerSampleExpr, type DiagRow } from './diag'

// Opt-in diagnostic (E2E_DIAG=1): a presenter and one viewer on this machine, no upload cap, at a
// high quality preset, with a high-entropy test pattern (the encoder runs at its full bitrate).
// Samples both pages every second and prints a timeline of the rate control's inputs and decisions
// (delivered rate and backlog per connection, measured capacity, the bitrate and what limits it),
// so a bitrate cut between two local tabs (where the network can't be the bottleneck) can be traced.
//
//   E2E_DIAG=1 DIAG_PRESET=ultra DIAG_SECONDS=75 DIAG_OUT=/tmp/diag.json npx playwright test diag-congestion
//
// Presets (e2e/diag.ts): ultra (1080p 16 Mbps), hi (1080p 8 Mbps), 4k (2160p 20 Mbps), auto (1080p
// 2.5 Mbps, Auto quality). DIAG_PATTERN=bars: the plain test pattern (~2 Mbps whatever the
// preset); bursty: still, with a burst of motion every 4 s (a mostly static screen).
// DIAG_KEYINT=ms sets the keyframe interval. DIAG_BLOCK=ms,everyMs blocks the presenter's main thread. DIAG_UP=kbps caps the presenter's upload.
// Playwright keeps every page visible; tools/diag-tabs.ts runs the same with real background tabs.

test.afterEach(closeContexts)

test('diagnostic: congestion between two local tabs', async ({ browser }) => {
  test.skip(!process.env.E2E_DIAG, 'opt-in diagnostic (E2E_DIAG=1)')
  const seconds = Number(process.env.DIAG_SECONDS ?? 75)
  const presetName = process.env.DIAG_PRESET ?? 'ultra'
  // DIAG_KBPS / DIAG_M: override the preset's bitrate, and the parity stripes (1 by default).
  const preset = { ...DIAG_PRESETS[presetName], ...(process.env.DIAG_KBPS ? { bitrate: Number(process.env.DIAG_KBPS) } : {}) }
  test.setTimeout((seconds + 120) * 1000)
  const seed = `e2e-diag-${Date.now()}`
  // No upload cap (openHost's default cap would be the bottleneck).
  // DIAG_UP=kbps: the presenter's debug upload cap (a token bucket in its uplink) instead of none.
  const up = process.env.DIAG_UP ? Number(process.env.DIAG_UP) : null
  const host = await openHost(browser, seed, {
    k: 4,
    m: Number(process.env.DIAG_M ?? 1),
    bitrate: preset.bitrate,
    res: preset.res,
    up,
    pattern: process.env.DIAG_PATTERN === 'bars' ? undefined : process.env.DIAG_PATTERN === 'bursty' ? 'bursty' : 'busy',
    autoQuality: presetName === 'auto',
  })
  const viewer = await openViewer(browser, seed, 'v')
  // A viewer that never gets going (a lossy, long path) is what the timeline should show, so go on.
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 60_000, 'viewer playing').catch((e) => console.log(String(e).slice(0, 300)))
  // DIAG_KEYINT=ms: the presenter's periodic keyframe interval instead of tuning's (e.g. 1e9: none
  // after the viewer started, to see what keyframes cost the latency).
  if (process.env.DIAG_KEYINT) {
    await host.evaluate((ms) => ((window.__p2p!.publishing as any).video.opts.keyframeIntervalMs = ms), Number(process.env.DIAG_KEYINT))
  }
  const viewerId = (await viewerSnapshot(viewer)).id
  const hostId = await host.evaluate(() => window.__p2p!.selfId)
  await host.evaluate(INSTALL_LAG)
  await viewer.evaluate(INSTALL_LAG)
  // DIAG_BLOCK=ms,everyMs: block the presenter's main thread (an overloaded computer).
  if (process.env.DIAG_BLOCK) {
    const [ms, every] = process.env.DIAG_BLOCK.split(',').map(Number)
    await host.evaluate(blockMainThreadExpr(ms, every))
  }
  // DIAG_SETQ=seconds,kbps: the presenter changes quality that far into the run (a preset change).
  const [setqAt, setqKbps] = process.env.DIAG_SETQ ? process.env.DIAG_SETQ.split(',').map(Number) : [Infinity, 0]
  const rows: DiagRow[] = []
  const t0 = Date.now()
  for (let i = 0; i < seconds; i++) {
    const tick = Date.now()
    if (i === setqAt) {
      await host.evaluate((kbps) => window.__p2p!.publishing!.setQuality(kbps), setqKbps)
      console.log(`[${i}s] quality -> ${setqKbps} kbps`)
    }
    const [h, v]: any[] = await Promise.all([host.evaluate(hostSampleExpr(viewerId)), viewer.evaluate(viewerSampleExpr(hostId))])
    const prev = rows.at(-1)
    rows.push({ t: Math.round((Date.now() - t0) / 100) / 10, h, v })
    if (prev && h.kbps !== prev.h.kbps) console.log(`[${rows.at(-1)!.t}s] bitrate ${prev.h.kbps} -> ${h.kbps}: ${JSON.stringify(h.rate)}`)
    if (h.localLoad && !prev?.h.localLoad) console.log(`[${rows.at(-1)!.t}s] local load: ${JSON.stringify(h.localLoad)}`)
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - tick))))
  }
  console.log(`preset ${presetName} (${preset.bitrate} kbps ${preset.res}), ${seconds} s${up ? `, upload cap ${up} kbps` : ''}`)
  console.log(formatTimeline(rows))
  if (process.env.DIAG_OUT) writeFileSync(process.env.DIAG_OUT, JSON.stringify({ preset: presetName, rows }, null, 1))
})
