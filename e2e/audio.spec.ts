import { expect, test } from '@playwright/test'
import { closeContexts, openHost, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test('audio plays continuously: under 300 ms of silence, while viewers join and relays take over', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-audio-${Date.now()}`
  await openHost(browser, seed, { k: 2, m: 1, audio: true, up: 20_000 })
  // Two more viewers join, so parents change and relays replay their caches mid-measurement.
  const v = await openViewer(browser, seed, 'listener')
  await waitFor(() => viewerSnapshot(v), (s) => s.decoded > 30, 45_000, 'frames')
  await v.evaluate(() => (window as Any).__p2p.player.audio.setMuted(false))
  await waitFor(() => v.evaluate(() => (window as Any).__p2p.player.audio.stats), (s: Any) => s.played > 25, 10_000, 'audio playing')
  const before = await v.evaluate(() => ({ ...(window as Any).__p2p.player.audio.stats }))
  await openViewer(browser, seed, 'r1')
  await openViewer(browser, seed, 'r2')
  await new Promise((r) => setTimeout(r, 15_000))
  // Wait for the worklet's next stats report.
  await new Promise((r) => setTimeout(r, 1000))

  const r = await v.evaluate(() => ({ mode: (window as Any).__p2p.player.audio.mode, stats: { ...(window as Any).__p2p.player.audio.stats } }))
  console.log('audio', JSON.stringify({ before, ...r }))
  // Played as one continuous stream by the worklet (the fallback path can click).
  expect(r.mode).toBe('worklet')
  // ~16 s of 40 ms frames.
  expect(r.stats.played - before.played).toBeGreaterThan(300)
  // Viewers joining moves relays around: allow a brief dropout or re-sync, but under 300 ms of
  // silence in all (each is faded, so it is a gap, not a click).
  expect(r.stats.silentMs - before.silentMs).toBeLessThan(300)
  expect(r.stats.resyncs - before.resyncs + r.stats.underruns - before.underruns).toBeLessThanOrEqual(2)
  expect(r.stats.skipped - before.skipped).toBeLessThan(5)
  expect(r.stats.bufferedMs).toBeGreaterThan(50)
})
