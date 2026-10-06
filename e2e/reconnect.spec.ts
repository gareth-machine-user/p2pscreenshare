import { expect, test, type Page } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { closeContexts, meshSnapshot, newContext, openMember, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

const ownerUrl = (seed: string) =>
  `/#/host?${new URLSearchParams({ stream: seed, tracker: TRACKER_URL, ice: 'none', name: 'owner', share: '1', source: 'test', res: '640x360', k: '1', m: '0', audio: '0' })}`

const all = (pages: Page[]) => Promise.all(pages.map(meshSnapshot))

/** Leaves like a crash or a killed browser: no goodbye record, links just die. */
async function vanish(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__mesh!.leave = async () => {}
    window.__p2p!.leave = async () => {}
  })
  await page.close()
}

test('the owner vanishes without a goodbye and comes back: everyone finds it again', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-owner-back-${Date.now()}`
  const ownerCtx = await newContext(browser)
  let owner = await ownerCtx.newPage()
  await owner.goto(ownerUrl(seed))
  const a = await openMember(browser, seed, 'a')
  const b = await openMember(browser, seed, 'b')
  await waitFor(() => viewerSnapshot(b), (s) => s.decoded > 30, 30_000, 'watching')

  await vanish(owner)
  await expect(a.getByTestId('owner-away')).toBeVisible({ timeout: 15_000 })
  await new Promise((r) => setTimeout(r, 20_000)) // long enough for door offers to go stale

  owner = await ownerCtx.newPage() // same profile: same owner seed and key
  await owner.goto(ownerUrl(seed))
  const t0 = Date.now()
  await waitFor(() => all([owner, a, b]), (ss) => ss.every((s) => s.members === 3 && s.openLinks === 2), 30_000, 'owner back')
  console.log(`owner re-meshed after ${Date.now() - t0} ms`)
  await expect(a.getByTestId('owner-away')).toHaveCount(0)
  await waitFor(() => viewerSnapshot(b), (s) => s.decoded > 30, 30_000, 'stream back')
  await ownerCtx.close()
})

test('a client that was offline for a while (page still open) finds the lobby and the owner again', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-offline-${Date.now()}`
  const ownerCtx = await newContext(browser)
  const owner = await ownerCtx.newPage()
  await owner.goto(ownerUrl(seed))
  const a = await openMember(browser, seed, 'a')
  const b = await openMember(browser, seed, 'b')
  await waitFor(() => viewerSnapshot(b), (s) => s.decoded > 30, 30_000, 'watching')

  // b drops off for 20 s: everyone declares it gone, and it declares everyone gone.
  await b.evaluate(() => window.__mesh!.debugGoOffline(20_000))
  await waitFor(() => all([owner, a]), (ss) => ss.every((s) => s.members === 2), 15_000, 'b dropped')
  await waitFor(() => meshSnapshot(b), (s) => s.members === 1, 15_000, 'b alone')

  const t0 = Date.now()
  await waitFor(() => all([owner, a, b]), (ss) => ss.every((s) => s.members === 3 && s.openLinks === 2), 40_000, 'b back')
  console.log(`b re-meshed ${Date.now() - t0} ms after starting to wait (offline window included)`)
  await expect(b.getByTestId('owner-away')).toHaveCount(0)
  const before = (await viewerSnapshot(b)).decoded
  await waitFor(() => viewerSnapshot(b), (s) => s.decoded > before + 30, 30_000, 'b watching again')
  await ownerCtx.close()
})

test('a client that reloads finds the owner, and so does a newcomer to a long-running lobby', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-reload-${Date.now()}`
  const ownerCtx = await newContext(browser)
  const owner = await ownerCtx.newPage()
  await owner.goto(ownerUrl(seed))
  const a = await openMember(browser, seed, 'a')
  const b = await openMember(browser, seed, 'b')
  await waitFor(() => viewerSnapshot(b), (s) => s.decoded > 30, 30_000, 'watching')
  // The lobby runs for a while (door offers created at the start are long past their prime).
  await new Promise((r) => setTimeout(r, 25_000))

  const url = b.url()
  const ctx = b.context()
  await vanish(b)
  await new Promise((r) => setTimeout(r, 8_000))
  const b2 = await ctx.newPage()
  await b2.goto(url)
  const c = await openMember(browser, seed, 'c')
  const t0 = Date.now()
  await waitFor(() => all([owner, a, b2, c]), (ss) => ss.every((s) => s.members === 4 && s.openLinks === 3), 30_000, 'everyone meshed')
  console.log(`b back and c in after ${Date.now() - t0} ms`)
  await expect(b2.getByTestId('owner-away')).toHaveCount(0)
  await waitFor(() => Promise.all([b2, c].map(viewerSnapshot)), (ss) => ss.every((s) => s.decoded > 30), 30_000, 'both watching')
  await ownerCtx.close()
})
