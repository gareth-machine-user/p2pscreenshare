import { expect, test } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { meshSnapshot, newContext, openHost, openMember, openOwner, openViewer, viewerSnapshot, waitFor, closeContexts } from './helpers'

test.afterEach(closeContexts)

const LOCAL = new URLSearchParams({ tracker: TRACKER_URL, ice: 'none' })

test('home and share settings persist across reloads; the creator stays owner', async ({ browser }) => {
  const ctx = await newContext(browser)
  const page = await ctx.newPage()
  await page.goto(`/?${LOCAL}#/`)
  await page.getByTestId('name').fill('Ada')
  await page.getByTestId('name').blur()
  await page.getByTestId('create-lobby').click()
  await expect(page).toHaveURL(/#\/lobby\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const lobbyUrl = page.url()

  // Share with non-default settings, using the test pattern.
  await page.getByTestId('share-screen').click()
  const dialog = page.getByTestId('share-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('quality-preset').selectOption('720p')
  if (!(await page.getByTestId('k').isVisible())) await dialog.locator('summary').click()
  await page.getByTestId('k').fill('2')
  await page.getByTestId('m').fill('2')
  await page.getByTestId('test-pattern').check()
  await page.getByTestId('system-audio').uncheck()
  await page.getByTestId('start-share').click()
  await expect(page.getByTestId('local-preview')).toBeVisible()
  await expect(page.getByTestId('stop-share')).toBeVisible()

  // Reload: still the owner (the seed stays on this device), and the dialog remembers the choices.
  await page.reload()
  await expect(page.getByTestId('share-screen')).toBeVisible()
  await page.getByTestId('share-screen').click()
  await expect(page.getByTestId('quality-preset')).toHaveValue('720p')
  await expect(page.getByTestId('k')).toHaveValue('2')
  await expect(page.getByTestId('m')).toHaveValue('2')
  await expect(page.getByTestId('test-pattern')).toBeChecked()
  await expect(page.getByTestId('system-audio')).not.toBeChecked()
  await page.keyboard.press('Escape')

  // The name persists on the home page.
  await page.goto(`/?${LOCAL}#/`)
  await expect(page.getByTestId('name')).toHaveValue('Ada')

  // A pasted lobby link joins that lobby.
  await page.getByTestId('paste-link').fill(lobbyUrl)
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page).toHaveURL(lobbyUrl)
  await ctx.close()
})

test('player overlay: starts muted, mute toggles, fullscreen targets the stage, gear opens stats', async ({ browser }) => {
  const seed = `e2e-overlay-${Date.now()}`
  await openHost(browser, seed, { k: 1, m: 0, audio: true })
  const viewer = await openViewer(browser, seed, 'ov')
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 45_000, 'frames')

  const stage = viewer.getByTestId('stage')
  await stage.hover()
  const mute = viewer.getByTestId('mute')
  await expect(mute).toBeVisible()
  await expect(mute).toHaveAttribute('aria-pressed', 'false')
  expect(await viewer.evaluate(() => (window.__p2p as { player: { audio: { muted: boolean } } }).player.audio.muted)).toBe(true)
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  expect(await viewer.evaluate(() => (window.__p2p as { player: { audio: { muted: boolean } } }).player.audio.muted)).toBe(false)

  await viewer.getByTestId('fullscreen').click()
  await expect.poll(() => viewer.evaluate(() => document.fullscreenElement?.getAttribute('data-testid') ?? null)).toBe('stage')
  // The overlay lives inside the fullscreen element, so it stays usable.
  await stage.hover()
  await expect(viewer.getByTestId('player-overlay')).toBeVisible()
  await viewer.getByTestId('fullscreen').click()
  await expect.poll(() => viewer.evaluate(() => document.fullscreenElement)).toBeNull()

  await viewer.getByTestId('gear').click()
  await expect(viewer.getByTestId('gear-panel')).toBeVisible()
  await expect(viewer.getByTestId('state')).toHaveText('connected')

  // The Topology tab fetches a (gzipped) report from the channel's publisher while it is open.
  await viewer.getByTestId('tab-topology').click()
  await expect(viewer.getByTestId('topology-panel')).toBeVisible({ timeout: 10_000 })
  await expect(viewer.getByTestId('topology-panel')).toContainText('Subscribers1')
})

test("a presenter sees what it shares, but only while the tab is focused", async ({ browser }) => {
  const ctx = await newContext(browser)
  const page = await ctx.newPage()
  // A real (fake-device) screen capture, not the test pattern.
  const q = new URLSearchParams({ stream: `e2e-preview-${Date.now()}`, tracker: TRACKER_URL, ice: 'none', share: '1', audio: '0' })
  await page.goto(`/#/host?${q}`)
  await expect(page.getByTestId('stop-share')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('local-preview')).toBeVisible()

  // Focus moves elsewhere (e.g. to the window being shared): the preview hides.
  await page.evaluate(() => {
    document.hasFocus = () => false
    window.dispatchEvent(new Event('blur'))
  })
  await expect(page.getByTestId('local-preview')).toHaveCount(0)
  await expect(page.getByTestId('stage-message')).toContainText('preview is hidden')

  // Back to the tab: the preview returns.
  await page.evaluate(() => {
    document.hasFocus = () => true
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByTestId('local-preview')).toBeVisible()
  await ctx.close()
})

test('guests must pick a name before chatting or asking to share', async ({ browser }) => {
  const seed = `e2e-names-${Date.now()}`
  const owner = await openOwner(browser, seed)
  // name='' : no name in the URL or in saved settings, so they join as anonymous guests.
  const zoe = await openMember(browser, seed, '', { name: '' })
  const yan = await openMember(browser, seed, '', { name: '' })
  await waitFor(() => meshSnapshot(owner), (s) => s.members === 3, 30_000, 'joined')

  // First chat message: the name dialog comes first, then the message goes out under that name.
  await zoe.getByTestId('chat-input').fill('hello')
  await zoe.getByTestId('chat-send').click()
  await expect(zoe.getByTestId('name-dialog')).toBeVisible()
  await expect(zoe.getByTestId('name-save')).toBeDisabled()
  await zoe.getByTestId('name-input').fill('Zoe')
  await zoe.getByTestId('name-save').click()
  await waitFor(() => meshSnapshot(owner), (s) => s.chat.includes('Zoe: hello'), 10_000, 'named chat')
  // Named now: no dialog the second time.
  await zoe.getByTestId('chat-input').fill('again')
  await zoe.getByTestId('chat-send').click()
  await expect(zoe.getByTestId('name-dialog')).toHaveCount(0)
  await waitFor(() => meshSnapshot(owner), (s) => s.chat.includes('Zoe: again'), 10_000, 'second chat')

  // Asking to share: same, and the owner's toast shows the new name.
  await yan.getByTestId('share-screen').click()
  await expect(yan.getByTestId('name-dialog')).toBeVisible()
  await yan.getByTestId('name-input').fill('Yan')
  await yan.getByTestId('name-save').click()
  await expect(owner.getByTestId('publish-request')).toContainText('Yan', { timeout: 10_000 })
})
