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

test('one slow viewer does not throttle the stream; a full uplink does', async ({ browser }) => {
  test.setTimeout(150_000)
  const seed = `e2e-slow-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0, bitrate: 2000, up: 20_000 })
  // Weak uploads, so neither relays: the presenter feeds both directly.
  const a = await openViewer(browser, seed, 'slow', 300)
  const b = await openViewer(browser, seed, 'fine', 300)
  await waitFor(() => Promise.all([a, b].map(viewerSnapshot)), (ss) => ss.every((s) => s.decoded > 30), 45_000, 'both watching')
  const ids = await Promise.all([a, b].map(async (p) => (await viewerSnapshot(p)).id))

  /** Makes the presenter's link to a viewer look like a slow receiver: its send buffer stays full. */
  const slowLink = (peer: string) =>
    owner.evaluate((id) => {
      const conn = (window.__p2p as Any).mesh.conns.get(id)
      Object.defineProperty(conn, 'bufferedAmount', { get: () => 64 * 1024 * 1024 })
    }, peer)
  const state = () =>
    owner.evaluate(() => {
      const s = window.__p2p as Any
      return { kbps: s.publishing.full.kbps as number, full: s.uplinkFull, links: Object.fromEntries(s.linkRates) as Record<string, { congested: boolean }> }
    })

  await slowLink(ids[0])
  await new Promise((r) => setTimeout(r, 15_000))
  const one = await state()
  console.log('one slow link:', JSON.stringify(one))
  expect(one.links[ids[0]]?.congested).toBe(true)
  expect(one.full).toBeNull()
  expect(one.kbps).toBe(2000) // not throttled
  expect((await viewerSnapshot(b)).fps).toBeGreaterThan(20) // the other viewer is unaffected

  // Both links back up together: that is what a full uplink looks like, so the bitrate drops.
  await slowLink(ids[1])
  await waitFor(state, (s) => s.kbps < 2000, 20_000, 'throttled on a full uplink')
  console.log('both slow:', JSON.stringify(await state()))
})
