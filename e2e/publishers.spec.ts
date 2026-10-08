import { expect, test, type Page } from '@playwright/test'
import { openHost, openMember, waitFor, closeContexts } from './helpers'

test.afterEach(closeContexts)

/** For page code that reaches past the session's types (forcing a stream by hand). */
type Any = any

/** What a page's session knows about live streams and its stage. */
function streams(page: Page) {
  return page.evaluate(() => {
    const s = window.__p2p!
    const name = (id: string) => s.mesh.member(id)?.name ?? (id === s.selfId ? s.mesh.record.name : id.slice(0, 4))
    return {
      id: s.selfId as string,
      live: s.liveStreams().map((c) => name(c.publisher)),
      selected: s.selected ? name(s.selected) : null,
      source: s.stageView().source as string,
      previews: Object.fromEntries(
        s.liveStreams().map((c) => [name(c.publisher), s.subFor(c.publisher, 'preview')?.player.stats.decodedFrames ?? -1]),
      ) as Record<string, number>,
      stageDecoded: (s.stageView().player?.stats.decodedFrames ?? 0) as number,
      log: s.stageLog.map((e) => `${e.publisher ? name(e.publisher) : '-'}:${e.source}`) as string[],
      canShare: s.canShare as boolean,
      publishing: !!s.publishing,
      rejected: s.relay.rejected as number,
    }
  })
}

test('two publishers: request and approve, tiles, preview while switching, mixed audio', async ({ browser }) => {
  test.setTimeout(150_000)
  const seed = `e2e-pubs-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 2, m: 1, bitrate: 1200, up: 8000, audio: true, mic: true })
  // Alice asks to share as soon as she is in (share=1), and shares once allowed.
  const alice = await openMember(browser, seed, 'alice', { share: '1', source: 'test', k: '1', m: '0', bitrate: '800', res: '640x360', up: '6000' })
  const viewer = await openMember(browser, seed, 'viewer')

  // The owner's presenter bar: mic and system audio mixed into one track, each with a mute.
  await expect(owner.getByTestId('presenter-bar')).toBeVisible({ timeout: 15_000 })
  await owner.getByTestId('mute-mic').click()
  await expect(owner.getByTestId('mute-mic')).toHaveAttribute('aria-pressed', 'true')
  await expect(owner.getByTestId('mute-system')).toHaveAttribute('aria-pressed', 'false')

  // The request shows up only for the owner; Alice waits.
  await expect(alice.getByTestId('request-waiting')).toBeVisible({ timeout: 20_000 })
  const req = owner.getByTestId('publish-request')
  await expect(req).toContainText('alice')
  await expect(viewer.getByTestId('publish-request')).toHaveCount(0)
  await req.getByTestId('allow').click()
  await waitFor(() => streams(alice), (s) => s.publishing, 15_000, 'alice publishing')

  // Two live streams: the viewer gets a tile rail with live previews, and the older stream on stage.
  const v = await waitFor(
    () => streams(viewer),
    (s) => s.live.length === 2 && s.selected === 'owner' && s.source === 'full' && s.stageDecoded > 10 && s.previews.alice > 3,
    30_000,
    'tiles and stage',
  )
  console.log('viewer before switch', v)
  await expect(viewer.getByTestId('tile')).toHaveCount(2)
  await expect(viewer.getByTestId('mute')).toBeVisible() // the owner's stream carries audio

  // Switch to Alice: her preview fills the stage until her first full-resolution frame.
  await viewer.locator(`[data-testid="tile"][data-publisher="${(await streams(alice)).id}"] .tile-pick`).click()
  const after = await waitFor(() => streams(viewer), (s) => s.selected === 'alice' && s.source === 'full' && s.stageDecoded > 10, 20_000, 'alice on stage')
  console.log('stage log', after.log)
  expect(after.log).toContain('alice:preview')
  expect(after.log.indexOf('alice:preview')).toBeLessThan(after.log.lastIndexOf('alice:full'))

  // Quality: Preview on the stage on request.
  await viewer.getByTestId('stage').hover()
  await viewer.getByTestId('quality').selectOption('preview')
  await waitFor(() => streams(viewer), (s) => s.source === 'preview' && s.stageDecoded > 0, 10_000, 'preview quality')
})

test('revoking a publisher stops its stream, and relays drop what it still sends', async ({ browser }) => {
  test.setTimeout(150_000)
  const seed = `e2e-revoke-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0, up: 8000 })
  const alice = await openMember(browser, seed, 'alice', { share: '1', source: 'test', k: '1', m: '0', bitrate: '600', res: '320x180' })
  const viewer = await openMember(browser, seed, 'viewer')
  await expect(owner.getByTestId('publish-request')).toBeVisible({ timeout: 20_000 })
  await owner.getByTestId('allow').click()
  await waitFor(() => streams(viewer), (s) => s.live.length === 2 && s.previews.alice > 0, 30_000, 'alice live')

  // The owner stops Alice's stream from its tile menu: her grant is revoked.
  await owner.locator(`[data-testid="tile"][data-publisher="${(await streams(alice)).id}"] [data-testid="tile-menu"]`).click()
  await owner.getByTestId('stop-stream').click()
  await expect(alice.getByTestId('revoked')).toBeVisible({ timeout: 10_000 })
  await waitFor(() => streams(alice), (s) => !s.publishing && !s.canShare, 10_000, 'alice stopped')
  await waitFor(() => streams(viewer), (s) => s.live.length === 1, 10_000, 'viewer drops alice')
  await expect(viewer.getByTestId('tile')).toHaveCount(0)

  // A revoked publisher that keeps sending anyway: the viewer rejects the fragments, plays nothing.
  // share() refuses without the right to publish, so force a stream by hand like a misbehaving client.
  expect(await alice.evaluate(() => window.__p2p!.share({ k: 1, m: 0, bitrateKbps: 600, source: 'test', audio: false }).then(() => 'ok', () => 'refused'))).toBe('refused')
  const forced = await alice.evaluate(async (viewerId: string) => {
    const s = window.__p2p as Any
    s.debugIgnoreRevocation = true
    const modulePath = '/src/session/publishedStream.ts'
    const { PublishedStream } = await import(/* @vite-ignore */ modulePath)
    const stream = new PublishedStream({ k: 1, m: 0, bitrateKbps: 600, source: 'test', audio: false, testSize: [320, 180] }, s)
    s.publishing = stream
    await stream.start()
    // Push the full channel straight at the viewer, as if it were a child.
    s.relay.addChild(stream.full.id, 0, viewerId)
    return stream.full.id
  }, (await streams(viewer)).id)
  const before = await streams(viewer)
  // Poll until the viewer has rejected a good run of the forced fragments (it took ~4 s of sending).
  const later = await waitFor(() => streams(viewer), (s) => s.rejected > before.rejected + 20, 15_000, 'forced fragments rejected')
  console.log('forced channel', forced, 'rejected', before.rejected, '->', later.rejected)
  expect(later.live).toEqual(['owner'])
})

test('deny, then allow all opens sharing to everyone', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-policy-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0 })
  const bob = await openMember(browser, seed, 'bob')
  const carol = await openMember(browser, seed, 'carol')
  await expect(bob.getByTestId('share-screen')).toHaveText(/Ask to share/, { timeout: 20_000 })

  await bob.getByTestId('share-screen').click()
  await owner.getByTestId('deny').click()
  await expect(bob.getByTestId('request-denied')).toBeVisible()

  await carol.getByTestId('share-screen').click()
  await owner.getByTestId('allow-all').click()
  // Carol is let in (her share dialog opens), and everyone else may now share without asking.
  await expect(carol.getByTestId('share-dialog')).toBeVisible({ timeout: 10_000 })
  await expect(bob.getByTestId('share-screen')).toHaveText(/Share screen/, { timeout: 10_000 })
  await owner.getByTestId('lobby-settings').click()
  await expect(owner.getByTestId('policy')).toHaveValue('open')
})

test('cancelling a request to share clears it for the owner', async ({ browser }) => {
  test.setTimeout(90_000)
  const seed = `e2e-cancel-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0 })
  const alice = await openMember(browser, seed, 'alice', { share: '1', source: 'test', k: '1', m: '0', bitrate: '600', res: '320x180' })
  await expect(alice.getByTestId('request-waiting')).toBeVisible({ timeout: 20_000 })
  await expect(owner.getByTestId('publish-request')).toContainText('alice', { timeout: 20_000 })

  // Alice changes her mind: the owner's toast goes away, so it can't be allowed after the fact.
  await alice.locator('.request-state button', { hasText: 'Cancel' }).click()
  await expect(alice.getByTestId('request-waiting')).toHaveCount(0)
  await expect(owner.getByTestId('publish-request')).toHaveCount(0, { timeout: 10_000 })
  await waitFor(() => streams(alice), (s) => !s.publishing && !s.canShare, 5_000, 'alice not granted')
})
