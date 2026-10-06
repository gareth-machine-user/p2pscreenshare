import { expect, test, type Page } from '@playwright/test'
import { hostSnapshot, openHost, openViewer, viewerSnapshot, waitFor, closeContexts, type HostSnapshot } from './helpers'

test.afterEach(closeContexts)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('deep tree: grandchildren do not blame healthy relays; departed children are pruned', async ({ browser }) => {
  test.setTimeout(180_000)
  const streamId = `e2e-deep-${Date.now()}`
  // k=1: one ~1.1-1.3 Mbps stripe (the publisher announces what it really sends). Publisher budget
  // = 1 child; 3600 kbps relays get 2 slots each, so the tree is host -> R -> {R', R''} -> leaves
  // (depth 3).
  const host = await openHost(browser, streamId, { k: 1, m: 0, bitrate: 1000, up: 1500 })
  const caps = [3600, 3600, 3600, 600, 600, 600]
  const pages: Page[] = []
  for (const [i, cap] of caps.entries()) pages.push(await openViewer(browser, streamId, `d${i}`, cap))
  const ids = await Promise.all(pages.map((p) => waitFor(() => viewerSnapshot(p), (s) => s.state === 'connected', 30_000, 'connected').then((s) => s.id)))
  const byId = new Map(ids.map((id, i) => [id, pages[i]]))

  const deepTree = (h: HostSnapshot) => {
    const depth = (id: string): number => (h.topology.parents[id]?.[0] === h.id ? 1 : 1 + depth(h.topology.parents[id]?.[0] ?? h.id))
    return Object.keys(h.topology.parents).length === caps.length && Math.max(...ids.map(depth)) >= 3
  }
  await waitFor(() => hostSnapshot(host), deepTree, 60_000, 'depth-3 tree')
  await sleep(4000) // let it stream
  // Re-snapshot right before choosing the victim: the tree may have been replanned while streaming.
  const h0 = await waitFor(() => hostSnapshot(host), deepTree, 15_000, 'depth-3 tree (still)')
  const parentOf = (id: string) => h0.topology.parents[id][0]!
  const top = ids.find((id) => parentOf(id) === h0.id)!
  const midRelays = ids.filter((id) => parentOf(id) === top && ids.some((c) => parentOf(c) === id))
  const grandkids = ids.filter((id) => midRelays.includes(parentOf(id)))
  console.log({ top: top.slice(0, 6), mid: midRelays.map((x) => x.slice(0, 6)), grandkids: grandkids.map((x) => x.slice(0, 6)) })
  expect(grandkids.length).toBeGreaterThan(0)

  // Kill the top relay: the mid relays are orphaned, and the grandchildren starve with them.
  await byId.get(top)!.context().close()
  const t0 = Date.now()
  const survivors = ids.filter((id) => id !== top)
  const before = await Promise.all(survivors.map((id) => viewerSnapshot(byId.get(id)!)))
  await waitFor(
    () => Promise.all(survivors.map((id) => viewerSnapshot(byId.get(id)!))),
    (ss) => ss.every((s, i) => s.decoded > before[i].decoded + 30),
    20_000,
    'everyone decoding again',
  )
  console.log(`all survivors decoding again after ${Date.now() - t0} ms`)
  await sleep(3000)

  const h1 = await hostSnapshot(host)
  for (const g of grandkids) {
    // The grandchild stayed with (or at least didn't blacklist) its healthy relay.
    expect(h1.health[g].avoid).not.toContain(parentOf(g))
  }
  for (const r of midRelays) expect(h1.health[r].failures).toBeLessThan(0.5)
  console.log('grandchild parents before/after', grandkids.map((g) => [parentOf(g).slice(0, 6), h1.topology.parents[g][0]?.slice(0, 6)]))

  // A leaf leaves: its parent should drop it from its child set promptly (not after ICE timeout).
  // Pick a leaf currently fed by another viewer (the topology may still be settling after the replan).
  const pickLeaf = (h: typeof h1) =>
    survivors.find((id) => h.topology.home[id] === null && byId.has(h.topology.parents[id]?.[0] ?? ''))
  const h2 = await waitFor(() => hostSnapshot(host), (h) => pickLeaf(h) !== undefined, 15_000, 'a leaf with a viewer parent')
  const leaf = pickLeaf(h2)!
  const parentPage = byId.get(h2.topology.parents[leaf][0]!)!
  expect((await viewerSnapshot(parentPage)).childIds).toContain(leaf)
  await byId.get(leaf)!.context().close()
  const t1 = Date.now()
  await waitFor(() => viewerSnapshot(parentPage), (s) => !s.childIds.includes(leaf), 15_000, 'parent prunes departed child')
  console.log(`parent pruned departed child after ${Date.now() - t1} ms`)
})
