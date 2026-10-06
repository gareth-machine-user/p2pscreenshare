import { expect, test, type Page } from '@playwright/test'
import { hostSnapshot, median, openHost, openViewer, PERF, viewerSnapshot, waitFor, type ViewerSnapshot, closeContexts } from './helpers'

test.afterEach(closeContexts)

// Heterogeneous audience: a few strong uplinks, several weak ones. Upload caps are enforced by
// each viewer's token-bucket shaper, so the probe and relaying behave like constrained peers.
// One relay per stripe: 9 Mbps is the least that serves all 8 peers on a ~0.8 Mbps stripe at 75%
// headroom, so the plan is feasible without overloading the publisher.
const CAPS = [12000, 12000, 9000, 800, 800, 800, 600, 600]

async function all(pages: Page[]): Promise<ViewerSnapshot[]> {
  return Promise.all(pages.map(viewerSnapshot))
}

test('striped tree (k=2, m=1): relays amplify, survives a relay leaving', async ({ browser }) => {
  test.setTimeout(240_000)
  const streamId = `e2e-tree-${Date.now()}`
  // The publisher plans ~1 child per stripe (3 root slots), so everyone else must be served by
  // relays. `up` shapes its real uplink too, so leave room for the one child it overcommits when
  // the stripe with the weakest relay runs short.
  const host = await openHost(browser, streamId, { k: 2, m: 1, bitrate: 1200, up: 3400 })
  const viewers: Page[] = []
  for (const [i, cap] of CAPS.entries()) viewers.push(await openViewer(browser, streamId, `v${i}`, cap))

  // Wait for relays to be promoted (min uptime 4s + probe) and the tree to settle.
  await waitFor(
    () => hostSnapshot(host),
    (h) => h.peers === CAPS.length && Object.values(h.topology.home).filter((x) => x !== null).length >= 2,
    60_000,
    'relays promoted',
  )
  await new Promise((r) => setTimeout(r, 12_000))

  const h = await hostSnapshot(host)
  const snaps = await all(viewers)
  console.table(snaps.map((s, i) => ({ v: i, cap: CAPS[i], home: s.home, children: s.children, fps: s.fps, latency: Math.round(s.latencyMs ?? -1), buffer: Math.round(s.bufferMs), probe: Math.round(s.probeKbps ?? -1), dropped: s.dropped })))
  console.log('host children', h.hostChildren, 'overcommitted', h.overcommitted)

  for (const s of snaps) {
    expect(s.state).toBe('connected')
    expect(s.fps).toBeGreaterThan(PERF.minFps)
    expect(s.parents.filter((p) => p !== null).length).toBeGreaterThanOrEqual(2) // any k of k+m
  }
  const lat = snaps.map((s) => s.latencyMs!).filter((x) => x !== null)
  expect(median(lat)).toBeLessThan(PERF.maxLatencyMs)
  // A peer relays only if its upload covers at least one stripe at the current stripe rate
  // (congestion control may lower the bitrate, which lets weaker peers carry a stripe).
  for (const [i, v] of viewers.entries()) {
    const stripeKbps = await v.evaluate(() => (window.__p2p as { stageSub?: { ann: { stripeKbps: number } } }).stageSub?.ann.stripeKbps ?? 0)
    if (snaps[i].home !== null) expect(CAPS[i] * 0.75).toBeGreaterThanOrEqual(stripeKbps * 0.9)
  }
  // The host serves only a few children; relays carry the rest.
  expect(h.hostChildren).toBeLessThanOrEqual(4)
  expect(snaps.some((s) => s.children > 0)).toBe(true)

  // Kill the busiest relay and check nobody freezes (m=1 covers one missing stripe).
  const victimIdx = snaps.reduce((best, s, i) => (s.children > snaps[best].children ? i : best), 0)
  console.log('closing relay', victimIdx, 'with', snaps[victimIdx].children, 'children')
  await viewers[victimIdx].context().close()
  const rest = viewers.filter((_, i) => i !== victimIdx)

  const before = await all(rest)
  const minFps: number[] = rest.map(() => Infinity)
  for (let t = 0; t < 8; t++) {
    await new Promise((r) => setTimeout(r, 500))
    const cur = await all(rest)
    cur.forEach((s, i) => (minFps[i] = Math.min(minFps[i], s.fps)))
  }
  const after = await all(rest)
  console.log('min fps per viewer during failover', minFps)
  after.forEach((s, i) => {
    expect(s.decoded).toBeGreaterThan(before[i].decoded + 60) // kept decoding through the failover
    expect(minFps[i]).toBeGreaterThan(PERF.minFailoverFps)
  })

  // The tree heals: nobody is left on the departed relay, and everyone has at least k live parents
  // (a stripe whose only relay left may stay unserved rather than overload the publisher).
  await waitFor(
    () => all(rest),
    (ss) => ss.every((s) => !s.parents.includes(snaps[victimIdx].id) && s.parents.filter((p) => p !== null).length >= 2),
    20_000,
    'reattach',
  )
})

test('single tree (k=1, m=0): orphans recover after their relay leaves; late joiner starts fast', async ({ browser }) => {
  test.setTimeout(180_000)
  const streamId = `e2e-single-${Date.now()}`
  // Host budget for exactly one child: everybody else hangs off relays.
  const host = await openHost(browser, streamId, { k: 1, m: 0, bitrate: 1000, up: 1500 })
  const caps = [10000, 10000, 600, 600, 600]
  const viewers: Page[] = []
  for (const [i, cap] of caps.entries()) viewers.push(await openViewer(browser, streamId, `s${i}`, cap))
  await waitFor(
    () => all(viewers),
    (ss) => ss.every((s) => s.fps > PERF.minFps) && ss.filter((s) => s.children > 0).length >= 1,
    60_000,
    'tree up',
  )
  await new Promise((r) => setTimeout(r, 6000))
  const snaps = await all(viewers)
  console.table(snaps.map((s, i) => ({ v: i, home: s.home, children: s.children, parent: s.parents[0]?.slice(0, 6), fps: s.fps, latency: Math.round(s.latencyMs ?? -1) })))
  expect((await hostSnapshot(host)).hostChildren).toBeLessThanOrEqual(2)

  // Kill a relay that has children; its orphans should resume within a few seconds.
  const victimIdx = snaps.findIndex((s) => s.children > 0)
  const victimId = snaps[victimIdx].id
  const orphans = viewers.filter((_, i) => snaps[i].parents[0] === victimId)
  console.log('closing relay', victimIdx, 'orphans', orphans.length)
  await viewers[victimIdx].context().close()
  const t0 = Date.now()
  const base = await all(orphans)
  await waitFor(
    () => all(orphans),
    (ss) => ss.every((s, i) => s.decoded > base[i].decoded + 30 && s.parents[0] !== victimId),
    20_000,
    'orphans recovered',
  )
  console.log(`orphans recovered after ${Date.now() - t0} ms`)

  // Late joiner: GOP cache lets it render quickly.
  const t1 = Date.now()
  const late = await openViewer(browser, streamId, 'late', 600)
  await waitFor(() => viewerSnapshot(late), (s) => s.decoded > 0, 20_000, 'late joiner first frame')
  console.log(`late joiner first frame after ${Date.now() - t1} ms`)
})
