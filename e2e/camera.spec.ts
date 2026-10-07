import { devices, expect, test } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { closeContexts, newContext, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

test('a phone (no screen capture) shares its camera, and flips cameras without restarting', async ({ browser }) => {
  const seed = `e2e-camera-${Date.now()}`
  const ctx = await newContext(browser, { ...devices['Pixel 7'] })
  const phone = await ctx.newPage()
  phone.on('pageerror', (e) => console.log('[phone pageerror]', e.message))
  // Mobile browsers have no getDisplayMedia: only the (fake) camera is left.
  await phone.addInitScript(() => {
    Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { value: undefined })
  })
  const q = new URLSearchParams({ stream: seed, tracker: TRACKER_URL, ice: 'none', name: 'phone' })
  await phone.goto(`/#/host?${q}`)

  const share = phone.getByTestId('share-screen')
  await expect(share).toHaveText(/Share camera/, { timeout: 20_000 })
  await share.click()
  const dialog = phone.getByTestId('share-dialog')
  await expect(dialog).toContainText('Share your camera')
  // No screen sources to pick, and no system audio: the camera is the source.
  await expect(phone.getByTestId('source-screen')).toHaveCount(0)
  await expect(phone.getByTestId('system-audio')).toHaveCount(0)
  await phone.getByTestId('facing-user').click()
  await phone.getByTestId('start-share').click()

  // The presenter sees its own (front, so mirrored) camera.
  const preview = phone.getByTestId('local-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveClass(/mirror/)
  await expect(phone.getByTestId('no-system-audio')).toHaveCount(0)
  await phone.waitForFunction(() => window.__p2p?.publishing?.opts.source === 'camera' && !!window.__p2p?.codec)

  const viewer = await openViewer(browser, seed, 'v1')
  const before = await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 45_000, 'camera frames')
  expect(before.state).toBe('connected')

  // Flip to the back camera: same stream, the viewer keeps decoding.
  const flip = phone.getByTestId('flip-camera')
  await expect(flip).toHaveText(/Back camera/)
  await flip.click()
  await expect(flip).toHaveText(/Front camera/, { timeout: 10_000 })
  await expect(preview).not.toHaveClass(/mirror/)
  expect(await phone.evaluate(() => window.__p2p?.publishing?.opts.facing)).toBe('environment')
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > before.decoded + 30, 30_000, 'frames after the flip')
})
