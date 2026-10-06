import { expect, test } from '@playwright/test'
import { closeContexts, hostSnapshot, median, openHost, openViewer, PERF, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

// The lossy hook and the keyframe counter reach into private session state.
type Any = any

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('one lossy viewer forces few keyframes, does not demote its relay, and does not hurt the other viewer', async ({ browser }) => {
  test.setTimeout(180_000)
  const seed = `e2e-lossy-${Date.now()}`
  // 2+1 stripes. The publisher's upload carries only a few stripe slots, so the healthy viewer
  // (uncapped) relays some stripes; the lossy one (300 kbps) can't relay, so its losses never
  // reach anyone else's feed.
  const host = await openHost(browser, seed, { k: 2, m: 1, bitrate: 1500, up: 4000 })
  const fine = await openViewer(browser, seed, 'fine')
  const lossy = await openViewer(browser, seed, 'lossy', 300)
  await waitFor(() => Promise.all([fine, lossy].map(viewerSnapshot)), (ss) => ss.every((s) => s.decoded > 30), 45_000, 'both watching')
  const [fineId, lossyId] = await Promise.all([fine, lossy].map(async (p) => (await viewerSnapshot(p)).id))

  /** Keyframes the publisher's encoder has produced (cumulative: scheduled, requested and reconfigured). */
  const keyframes = () => host.evaluate(() => (window.__p2p as Any).publishing.video.keyframes as number)

  // Baseline: about one scheduled keyframe per 10 s (quality profile).
  await sleep(4000) // let the tree settle (relays are trusted after 4 s)
  const k0 = await keyframes()
  await sleep(20_000)
  const baseline = (await keyframes()) - k0
  console.log('keyframes in 20 s without loss:', baseline)

  // The lossy viewer's downlink: 10% of media fragments lost at random, and every 6 s nothing at
  // all for 2 s (long enough for its stripes to look dead: reattach complaints about its parents).
  await lossy.evaluate(() => {
    const relay = (window.__p2p as Any).relay
    const receive = relay.receive.bind(relay)
    const t0 = performance.now()
    const w = window as Any
    w.__lossyDropped = 0
    relay.receive = (raw: Uint8Array, from: string) => {
      const blackout = (performance.now() - t0) % 6000 < 2000
      if (blackout || Math.random() < 0.1) {
        w.__lossyDropped++
        return
      }
      receive(raw, from)
    }
  })

  const k1 = await keyframes()
  const fps: number[] = []
  let lossyWaited = 0
  for (let i = 0; i < 15; i++) {
    await sleep(2000)
    const [f, l] = await Promise.all([viewerSnapshot(fine), viewerSnapshot(lossy)])
    fps.push(f.fps)
    if (l.waitingForKeyframe) lossyWaited++
  }
  const during = (await keyframes()) - k1
  const dropped = await lossy.evaluate(() => (window as Any).__lossyDropped as number)
  const h = await hostSnapshot(host)
  console.log('keyframes in 30 s with a lossy viewer:', during, { dropped, lossyWaited, fineFps: fps, health: h.health })

  expect(dropped).toBeGreaterThan(100) // the hook really dropped media
  // KeyframeGate: a lone requester gets one keyframe at once, then one after 4 s, 8 s, then every
  // 10 s, and forced keyframes restart the scheduled interval: at most ~5 in 30 s. The old global
  // 300 ms throttle let it force one per request (every 500 ms while its chain kept breaking).
  expect(during).toBeLessThanOrEqual(Math.max(8, baseline + 5))
  // Its complaints came with every stripe silent at once: its own downlink, not its parents.
  expect(h.health[fineId]?.failures ?? 0).toBeLessThan(1)
  // The healthy viewer keeps playing smoothly.
  expect(median(fps)).toBeGreaterThan(PERF.minFps)
  // The lossy viewer is still subscribed (it is moved, not dropped).
  expect(Object.keys(h.topology.parents)).toContain(lossyId)
})
