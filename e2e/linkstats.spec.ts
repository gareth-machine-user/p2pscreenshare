import { expect, test } from '@playwright/test'
import { closeContexts, openHost, openViewer, viewerSnapshot, waitFor } from './helpers'

test.afterEach(closeContexts)

// Reaches into the page's connections.
type Any = any

/**
 * What Chrome's getStats() actually exposes on a real data-channel-only connection: dumps the
 * selected candidate pair, the transport and any sctp-transport report, and measures how often the
 * pair's round-trip time refreshes (STUN checks on a connected pair).
 */
test('getStats: real fields, RTT refresh cadence, and the per-link stats the app derives', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-linkstats-${Date.now()}`
  const host = await openHost(browser, seed, { k: 2, m: 0, bitrate: 1500, up: 20_000 })
  const viewer = await openViewer(browser, seed, 'v')
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 45_000, 'viewer playing')
  const viewerId = (await viewerSnapshot(viewer)).id

  // One raw report from the host's mesh connection to the viewer.
  const dump = await host.evaluate(async (id) => {
    const conn = (window.__p2p as Any).mesh.conns.get(id)
    const report: RTCStatsReport = await conn.pc.getStats()
    const out: Record<string, unknown[]> = {}
    report.forEach((r: Any) => {
      if (['candidate-pair', 'transport', 'sctp-transport', 'data-channel', 'peer-connection', 'local-candidate', 'remote-candidate'].includes(r.type)) {
        ;(out[r.type] ??= []).push(r)
      }
    })
    return out
  }, viewerId)
  const types = Object.keys(dump)
  console.log('report types:', types.join(', '))
  const transport = dump['transport']?.[0] as Any
  const pair = (dump['candidate-pair'] as Any[]).find((p) => p.id === transport?.selectedCandidatePairId)
  console.log('transport:', JSON.stringify(transport))
  console.log('selected candidate-pair:', JSON.stringify(pair))
  console.log('sctp-transport:', JSON.stringify(dump['sctp-transport'] ?? null))
  console.log('data-channel[0]:', JSON.stringify(dump['data-channel']?.[0] ?? null))
  expect(pair).toBeTruthy()
  expect(typeof pair.currentRoundTripTime).toBe('number')

  // RTT refresh cadence: poll the selected pair every 100 ms for 20 s and note when it changes.
  const cadence = await host.evaluate(async (id) => {
    const conn = (window.__p2p as Any).mesh.conns.get(id)
    const seen: { at: number; rtt: number; responses: number; totalRtt: number }[] = []
    let last: string | null = null
    const t0 = performance.now()
    while (performance.now() - t0 < 20_000) {
      const report: RTCStatsReport = await conn.pc.getStats()
      let pairId: string | undefined
      report.forEach((r: Any) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId
      })
      const p = pairId ? (report.get(pairId) as Any) : null
      if (p) {
        const key = `${p.responsesReceived}/${p.currentRoundTripTime}`
        if (key !== last) {
          last = key
          seen.push({ at: Math.round(performance.now() - t0), rtt: p.currentRoundTripTime, responses: p.responsesReceived, totalRtt: p.totalRoundTripTime })
        }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    return seen
  }, viewerId)
  const gaps = cadence.slice(1).map((s, i) => s.at - cadence[i].at)
  console.log('rtt updates:', JSON.stringify(cadence))
  console.log('update gaps (ms):', gaps.join(' '))
  expect(cadence.length).toBeGreaterThan(2)

  // The app's per-link stats (polled every 2 s): every connection to the viewer has an RTT and a baseline.
  const links = await waitFor(
    () => host.evaluate((id) => (window.__p2p as Any).linkStatsFor(id) as Any[], viewerId),
    (ls) => ls.length > 0 && ls.every((l: Any) => l.rttMs !== null && l.baselineMs !== null && l.fresh),
    20_000,
    'per-link stats',
  )
  console.log('app link stats:', JSON.stringify(links))

  // The presenter bar shows a live, non-zero upload figure while streaming.
  const upload = host.getByTestId('live-upload')
  await expect(upload).toHaveText(/Uploading (?!0\.0 )\d+\.\d+ Mbps/, { timeout: 10_000 })
  console.log('presenter bar:', await upload.textContent())

  // Stats (the gear's default tab): every member with its estimated upload, and live rates to the
  // directly connected viewer.
  await host.getByTestId('stage').hover()
  await host.getByTestId('gear').click()
  const rateRow = host.locator(`[data-testid="peer-rate-row"][data-peer="${viewerId}"]`)
  await expect(rateRow).toHaveAttribute('data-direct', 'true')
  await expect(rateRow).toContainText(/\d\.\d+ Mbps/)
  await expect(rateRow).toContainText('est.')
  console.log('stats peer row:', (await rateRow.textContent())?.replace(/\s+/g, ' '))

  // Topology: numbered nodes (P for the publisher) matching the numbered table.
  await host.getByTestId('tab-topology').click()
  await expect(host.locator(`[data-testid="tree-node"][data-peer="${viewerId}"] [data-testid="tree-label"]`).first()).toHaveText('1')
  await expect(host.locator('[data-testid="tree-node"]').first()).toBeVisible()
  await expect(host.locator(`[data-testid="topo-row"][data-peer="${viewerId}"] [data-testid="topo-num"]`)).toHaveText('#1')
  expect(await host.locator('[data-testid="tree-label"]').allTextContents()).toContain('P')

  // The Peers panel: live sending / receiving per peer, and a row per connection when expanded.
  await host.getByTestId('tab-peers').click()
  const row = host.locator(`[data-testid="peer-row"][data-peer="${viewerId}"]`)
  await expect(row.getByTestId('live-send')).toHaveText(/\d\.\d+ Mbps/)
  await row.getByTestId('expand-lanes').click()
  await expect(host.locator(`[data-testid="lane-row"][data-peer="${viewerId}"]`).first()).toBeVisible()
  console.log('peer row:', (await row.textContent())?.replace(/\s+/g, ' '))
  console.log('lane rows:', (await host.locator(`[data-testid="lane-row"][data-peer="${viewerId}"]`).allTextContents()).map((t) => t.replace(/\s+/g, ' ')).join(' | '))

  // The viewer's Stats overlay: what it receives right now.
  await viewer.getByTestId('stage').hover()
  await viewer.getByTestId('gear').click()
  await expect(viewer.getByTestId('live-recv-total')).toHaveText(/(?!0\.0 )\d+\.\d+ Mbps/, { timeout: 10_000 })
  console.log('viewer receiving:', await viewer.getByTestId('live-recv-total').textContent())
})
