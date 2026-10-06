import { expect, test, type Page } from '@playwright/test'
import { closeContexts, meshSnapshot, openHost, openMember, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

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
