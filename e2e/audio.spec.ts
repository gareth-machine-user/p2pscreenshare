import { expect, test } from '@playwright/test'
import { closeContexts, openHost, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

test('audio plays continuously: back to back, nothing missing, while viewers join and relays take over', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-audio-${Date.now()}`
  await openHost(browser, seed, { k: 2, m: 1, audio: true, up: 20_000 })
  // Two more viewers join, so parents change and relays replay their caches mid-measurement.
  const v = await openViewer(browser, seed, 'listener')
  await waitFor(() => viewerSnapshot(v), (s) => s.decoded > 30, 45_000, 'frames')
  // Record every audio chunk the viewer schedules: when it starts and how long it lasts.
  await v.evaluate(() => {
    const w = window as Any
    w.__sched = []
    const start = AudioBufferSourceNode.prototype.start
    AudioBufferSourceNode.prototype.start = function (when?: number, ...rest: Any[]) {
      w.__sched.push([when ?? 0, this.buffer?.duration ?? 0])
      return (start as Any).call(this, when, ...rest)
    }
    w.__p2p.player.audio.setMuted(false)
  })
  await openViewer(browser, seed, 'r1')
  await openViewer(browser, seed, 'r2')
  await new Promise((r) => setTimeout(r, 15_000))

  const r = await v.evaluate(() => {
    const s = ((window as Any).__sched as [number, number][]).slice(25) // skip start-up
    let gapMs = 0
    for (let i = 1; i < s.length; i++) {
      const d = s[i][0] - (s[i - 1][0] + s[i - 1][1])
      if (d > 0.002) gapMs += d * 1000
    }
    const span = s.length ? s[s.length - 1][0] + s[s.length - 1][1] - s[0][0] : 0
    const covered = s.reduce((a, x) => a + x[1], 0)
    return { chunks: s.length, spanS: span, coveredS: covered, gapMs: Math.round(gapMs), stats: (window as Any).__p2p.player.audio.stats }
  })
  console.log('audio', JSON.stringify(r))
  expect(r.chunks).toBeGreaterThan(400)
  // At least 97% of the time span is covered by audio, and gaps add up to under 300 ms.
  expect(r.coveredS / r.spanS).toBeGreaterThan(0.97)
  expect(r.gapMs).toBeLessThan(300)
})
