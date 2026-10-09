import { devices, expect, test, type Browser, type Page } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { hostIdentity } from '../src/net/lobby'
import { closeContexts, newContext, openHost, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

type Device = 'iPhone 13' | 'Pixel 7'

/** A viewer on an emulated phone (Chromium with the phone's viewport, touch and user agent). */
async function openPhone(browser: Browser, seed: string, device: Device, o: { landscape?: boolean; noFullscreenApi?: boolean } = {}): Promise<Page> {
  const { defaultBrowserType: _, viewport, screen, ...opts } = devices[device]
  const flip = <T extends { width: number; height: number }>(s: T) => (o.landscape ? { width: s.height, height: s.width } : s)
  const ctx = await newContext(browser, { ...opts, viewport: flip(viewport), screen: screen && flip(screen) })
  // iPhone Safari: no Fullscreen API on anything but a <video>.
  if (o.noFullscreenApi) {
    await ctx.addInitScript(() => {
      delete (Element.prototype as Partial<Element>).requestFullscreen
      delete (Element.prototype as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false })
    })
  }
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${device} pageerror]`, e.message))
  const { joinCode } = await hostIdentity(seed)
  await page.goto(`/#/lobby/${joinCode}?${new URLSearchParams({ tracker: TRACKER_URL, name: 'phone', ice: 'none' })}`)
  await waitFor(() => viewerSnapshot(page), (s) => s.decoded > 30, 45_000, 'frames')
  return page
}

/** How much of the picture (the canvas's letterboxed content) the details panel covers, 0..1. */
function statsCoverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=video]')!
    const b = c.getBoundingClientRect()
    const scale = Math.min(b.width / c.width, b.height / c.height)
    const w = c.width * scale
    const h = c.height * scale
    const v = { left: b.left + (b.width - w) / 2, top: b.top + (b.height - h) / 2, right: 0, bottom: 0 }
    v.right = v.left + w
    v.bottom = v.top + h
    const p = document.querySelector('[data-testid=gear-panel]')!.getBoundingClientRect()
    const ow = Math.max(0, Math.min(v.right, p.right) - Math.max(v.left, p.left))
    const oh = Math.max(0, Math.min(v.bottom, p.bottom) - Math.max(v.top, p.top))
    return (ow * oh) / (w * h)
  })
}

/** Shows the controls (a tap on the picture), if they aren't already. */
async function showControls(page: Page): Promise<void> {
  const overlay = page.getByTestId('player-overlay')
  if ((await overlay.evaluate((e) => getComputedStyle(e).opacity)) !== '1') await page.getByTestId('stage').tap({ position: { x: 30, y: 30 } })
  await expect.poll(() => overlay.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
}

test('phone: the details open on request as a sheet that leaves most of the picture in view', async ({ browser }) => {
  const seed = `e2e-phone-stats-${Date.now()}`
  await openHost(browser, seed, { k: 1, m: 0, res: '1280x720' })
  for (const [device, landscape] of [['Pixel 7', false], ['iPhone 13', true]] as const) {
    const page = await openPhone(browser, seed, device, { landscape })
    // Collapsed until asked for.
    await expect(page.getByTestId('gear-panel')).toHaveCount(0)
    await showControls(page)
    // The controls are one compact row, not three over the picture.
    expect((await page.getByTestId('player-overlay').boundingBox())!.height).toBeLessThan(50)
    await page.getByTestId('gear').tap()
    await expect(page.getByTestId('state')).toHaveText('connected')
    const covered = await statsCoverage(page)
    console.log(device, landscape ? 'landscape' : 'portrait', 'stats cover', covered.toFixed(2))
    expect(covered).toBeLessThan(0.5)
    // Its own close button, as the gear may be under the sheet.
    await page.getByTestId('gear-close').tap()
    await expect(page.getByTestId('gear-panel')).toHaveCount(0)

    // Fullscreen: still most of the picture in view.
    await showControls(page)
    await page.getByTestId('fullscreen').tap()
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null)).toBe('stage')
    await showControls(page)
    await page.getByTestId('gear').tap()
    expect(await statsCoverage(page)).toBeLessThan(0.5)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('gear-panel')).toHaveCount(0)
    await page.close()
  }
})

test('phone without the Fullscreen API (iPhone): the stage fills the window, and the button, Escape and Back leave', async ({ browser }) => {
  const seed = `e2e-phone-fs-${Date.now()}`
  await openHost(browser, seed, { k: 1, m: 0 })
  const page = await openPhone(browser, seed, 'iPhone 13', { noFullscreenApi: true })
  const url = page.url()
  const stage = page.getByTestId('stage')
  const fillsWindow = async () => {
    const r = await stage.boundingBox()
    const vp = page.viewportSize()!
    return !!r && r.x === 0 && r.y === 0 && Math.round(r.width) === vp.width && Math.round(r.height) === vp.height
  }
  const enter = async () => {
    await showControls(page)
    await page.getByTestId('fullscreen').tap()
    await expect(stage).toHaveClass(/fills-window/)
    await expect.poll(fillsWindow).toBe(true)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  }

  // The button, both ways; the history entry it added is gone again.
  const historyLength = await page.evaluate(() => history.length)
  await enter()
  await showControls(page)
  await expect(page.getByTestId('fullscreen')).toHaveAttribute('aria-label', 'Exit fullscreen')
  await page.getByTestId('fullscreen').tap()
  await expect(stage).not.toHaveClass(/fills-window/)
  expect(await fillsWindow()).toBe(false)
  await expect.poll(() => page.evaluate(() => history.state?.stageFullscreen ?? null)).toBeNull()

  // Escape.
  await enter()
  await page.keyboard.press('Escape')
  await expect(stage).not.toHaveClass(/fills-window/)

  // Back leaves fullscreen, not the lobby.
  await enter()
  await page.goBack()
  await expect(stage).not.toHaveClass(/fills-window/)
  expect(page.url()).toBe(url)
  expect(await page.evaluate(() => history.length)).toBe(historyLength + 1)
  const before = (await viewerSnapshot(page)).decoded
  await waitFor(() => viewerSnapshot(page), (s) => s.decoded > before + 10, 10_000, 'still playing')
})
