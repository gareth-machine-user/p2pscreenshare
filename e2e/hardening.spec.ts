import { expect, test, type Page } from '@playwright/test'
import { closeContexts, meshSnapshot, openHost, openMember, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

// The slow-link test reaches into private session state.
type Any = any

test('auto quality: an audience that cannot carry the stream gets a lower bitrate', async ({ browser }) => {
  test.setTimeout(180_000)
  const seed = `e2e-auto-${Date.now()}`
  // 2.5 Mbps in 2+1 stripes, but the viewers can upload only 600 kbps each and the publisher 4 Mbps:
  // nowhere near the 6 × 3 stripe slots needed.
  const owner = await openHost(browser, seed, { k: 2, m: 1, bitrate: 2500, up: 4000, autoQuality: true })
  const viewers: Page[] = []
  for (let i = 0; i < 6; i++) viewers.push(await openViewer(browser, seed, `w${i}`, 600))
  const kbps = () => owner.evaluate(() => window.__p2p!.publishing?.full?.kbps)
  expect(await kbps()).toBe(2500)

  // The presenter is told, and the stream restarts at a bitrate the audience can carry.
  await expect(owner.getByTestId('audience-limited')).toBeVisible({ timeout: 40_000 })
  console.log('warning:', await owner.getByTestId('audience-limited').textContent())
  await waitFor(kbps, (k) => k !== undefined && k < 2500, 40_000, 'restarted at a lower bitrate')
  console.log('new bitrate', await kbps())

  // Everyone plays the new channel.
  await waitFor(
    () => Promise.all(viewers.map(viewerSnapshot)),
    (ss) => ss.every((s) => s.decoded > 30 && s.fps > 10),
    40_000,
    'viewers play the lower bitrate',
  )
})

test('the owner kicks a member: links close, and a reload does not get it back in', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-kick-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0 })
  const a = await openMember(browser, seed, 'a')
  const b = await openMember(browser, seed, 'b')
  const mallory = await openMember(browser, seed, 'mallory')
  const all = [owner, a, b, mallory]
  await waitFor(() => Promise.all(all.map(meshSnapshot)), (ss) => ss.every((s) => s.members === 4), 30_000, 'meshed')
  const malloryId = (await meshSnapshot(mallory)).id

  await owner.getByTestId('stage').hover()
  await owner.getByTestId('gear').click()
  await owner.getByTestId('tab-peers').click()
  await owner.locator(`[data-peer="${malloryId}"] [data-testid="kick"]`).click()

  await expect(mallory.getByTestId('kicked')).toBeVisible({ timeout: 10_000 })
  await waitFor(() => Promise.all([owner, a, b].map(meshSnapshot)), (ss) => ss.every((s) => s.members === 3), 15_000, 'mallory gone')

  // Same key after a reload: the doors refuse it.
  await mallory.reload()
  await new Promise((r) => setTimeout(r, 10_000))
  const ss = await Promise.all([owner, a, b].map(meshSnapshot))
  expect(ss.every((s) => s.members === 3)).toBe(true)
  expect((await meshSnapshot(mallory)).openLinks).toBe(0)
})

test('one slow viewer does not throttle the stream; a capped uplink does, down to what it carries', async ({ browser }) => {
  test.setTimeout(180_000)
  const seed = `e2e-slow-${Date.now()}`
  const KBPS = 2000
  const owner = await openHost(browser, seed, { k: 1, m: 0, bitrate: KBPS, up: 20_000 })
  // Weak uploads, so neither relays: the presenter feeds both directly.
  const a = await openViewer(browser, seed, 'slow', 300)
  const b = await openViewer(browser, seed, 'fine', 300)
  await waitFor(() => Promise.all([a, b].map(viewerSnapshot)), (ss) => ss.every((s) => s.decoded > 30), 45_000, 'both watching')
  const ids = await Promise.all([a, b].map(async (p) => (await viewerSnapshot(p)).id))

  /**
   * Makes the presenter's link to a viewer look like a slow receiver: its send buffer stays full,
   * though it keeps draining (a buffer that never drains is a stalled connection, which the uplink
   * routes around: net/uplink.ts STALL_MS). Its queue never empties and it delivers next to nothing.
   */
  const slowLink = (peer: string) =>
    owner.evaluate((id) => {
      const conn = (window.__p2p as Any).mesh.conns.get(id)
      Object.defineProperty(conn, 'bufferedAmount', { configurable: true, get: () => 64 * 1024 * 1024 - (performance.now() % 1000) })
    }, peer)
  const state = () =>
    owner.evaluate((peers) => {
      const s = window.__p2p as Any
      return {
        kbps: s.publishing.full.kbps as number,
        rate: s.rateStatus(),
        uplinkKbps: s.capacity.uplinkKbps as number | null,
        peers: peers.map((p: string) => s.peerCapacity(p)) as { kbps: number | null; bound: boolean }[],
        // The slow viewer's mesh link (k=1: the one stripe goes over it).
        slowLink: (s.linkStatsFor(peers[0]) as Any[]).find((l) => l.lane === 0) as { capKbps: number | null; bound: boolean; backlogged: boolean },
      }
    }, ids)

  // The uplink is measured (headroom probe), at about the 20 Mbps cap.
  await waitFor(state, (st) => (st.uplinkKbps ?? 0) > 10_000, 30_000, 'uplink measured')
  await slowLink(ids[0])
  await new Promise((r) => setTimeout(r, 15_000))
  const one = await state()
  console.log('one slow link:', JSON.stringify(one))
  // The slow viewer's connection is its own bottleneck, the bitrate holds for the other one.
  expect(one.peers[0].bound).toBe(true)
  expect(one.slowLink).toMatchObject({ bound: true, backlogged: true })
  expect(one.slowLink.capKbps!).toBeLessThan(KBPS)
  expect(one.kbps).toBe(KBPS)
  expect(one.rate.limit).toBe('chosen')
  expect((await viewerSnapshot(b)).fps).toBeGreaterThan(20) // the other viewer is unaffected

  // Back to normal, then the presenter's uplink is capped below what two full copies need: the
  // token bucket carries 2.5 Mbps, so its queues back up on both links at once. The bitrate settles
  // at 85% of what that carries per viewer.
  await owner.evaluate((id) => delete (window.__p2p as Any).mesh.conns.get(id).bufferedAmount, ids[0])
  const CAP = 2500
  await owner.evaluate((cap) => ((window.__p2p as Any).uplink.capKbps = cap), CAP)
  // Video per viewer at a wire budget of CAP / 2 (k=1, no audio: stripeKbpsFor = v × 1.05 + 15).
  const settle = (0.85 * (CAP / 2 - 15)) / 1.05
  const capped = await waitFor(state, (st) => st.kbps <= settle * 1.15, 30_000, 'bitrate under the cap')
  console.log('capped uplink:', JSON.stringify(capped))
  expect(capped.rate.limit).toBe('uplink')
  expect(capped.uplinkKbps!).toBeLessThan(CAP * 1.1)
  // It stays there (no oscillation back up to the chosen quality), and both viewers keep playing.
  const kbpsSeen: number[] = []
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    kbpsSeen.push((await state()).kbps)
  }
  console.log('settled:', kbpsSeen.join(' '), 'target', Math.round(settle))
  for (const k of kbpsSeen) {
    expect(k).toBeLessThanOrEqual(settle * 1.15)
    expect(k).toBeGreaterThanOrEqual(settle * 0.6)
  }
  const ss = await Promise.all([a, b].map(viewerSnapshot))
  expect(ss.every((s) => s.fps > 10)).toBe(true)
})
