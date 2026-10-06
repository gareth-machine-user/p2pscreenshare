import { expect, test } from '@playwright/test'
import { openHost, openViewer, viewerSnapshot, waitFor, closeContexts } from './helpers'

test.afterEach(closeContexts)

test('star: host streams to two viewers (k=1, m=0)', async ({ browser }) => {
  const streamId = `e2e-star-${Date.now()}`
  await openHost(browser, streamId, { k: 1, m: 0 })
  const viewers = [await openViewer(browser, streamId, 'v1'), await openViewer(browser, streamId, 'v2')]

  for (const v of viewers) {
    const snap = await waitFor(() => viewerSnapshot(v), (s) => s.decoded > 60 && s.latencyMs !== null, 45_000, 'frames')
    console.log('viewer', snap)
    expect(snap.state).toBe('connected')
    expect(snap.latencyMs!).toBeLessThan(1500)
  }
})
