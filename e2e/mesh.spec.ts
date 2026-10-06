import { expect, test, type Page } from '@playwright/test'
import { meshSnapshot, openHost, openMember, openOwner, viewerSnapshot, waitFor, closeContexts } from './helpers'

test.afterEach(closeContexts)

const all = (pages: Page[]) => Promise.all(pages.map(meshSnapshot))

test('six peers mesh up, one leaves, a blocked pair is gossiped, chat reaches everyone', async ({ browser }) => {
  test.setTimeout(180_000)
  const seed = `e2e-mesh-${Date.now()}`
  const owner = await openOwner(browser, seed)
  const members: Page[] = []
  // m1 refuses a link with m2 (as if ICE failed for that pair).
  for (const [i, extra] of ([{}, { block: 'm2' }, {}, {}, {}] as Record<string, string>[]).entries()) members.push(await openMember(browser, seed, `m${i}`, extra))
  const pages = [owner, ...members]

  // Everyone knows all six members; every pair but the blocked one has a direct link.
  const t0 = Date.now()
  const snaps = await waitFor(
    () => all(pages),
    (ss) => ss.every((s) => s.members === 6) && ss.filter((s) => s.openLinks === 5).length === 4,
    60_000,
    'full mesh',
  )
  console.log(`meshed in ${Date.now() - t0} ms`, snaps.map((s) => `${s.name}:${s.openLinks}${s.isDoor ? ' door' : ''}`).join(' '))
  const byName = new Map(snaps.map((s) => [s.name, s]))
  const m1 = byName.get('m1')!.id
  const m2 = byName.get('m2')!.id

  // The blocked pair shows up in gossip: a third peer sees it in their records.
  const third = await waitFor(
    () => meshSnapshot(members[3]),
    (s) => !!s.records[m1]?.unreachable.includes(m2) || !!s.records[m2]?.unreachable.includes(m1),
    30_000,
    'unreachable pair gossiped',
  )
  console.log('m3 sees m1 unreachable:', third.records[m1].unreachable, 'm2 unreachable:', third.records[m2].unreachable)
  // ...and in the Peers panel.
  await members[3].getByTestId('stage').hover()
  await members[3].getByTestId('gear').click()
  await members[3].getByTestId('tab-peers').click()
  await expect(members[3].locator(`[data-peer="${m1}"] [data-testid="unreachable-count"]`)).toHaveText('1')

  // Chat reaches everyone, including across the blocked pair.
  await members[1].getByTestId('chat-input').fill('hello from m1')
  await members[1].getByTestId('chat-send').click()
  await waitFor(() => all(pages), (ss) => ss.every((s) => s.chat.includes('m1: hello from m1')), 15_000, 'chat everywhere')
  await expect(members[2].getByTestId('chat-msg').filter({ hasText: 'hello from m1' })).toBeVisible()

  // One leaves without saying goodbye: the rest notice and the count drops.
  await members[4].context().close()
  const t1 = Date.now()
  const rest = pages.filter((p) => p !== members[4])
  await waitFor(() => all(rest), (ss) => ss.every((s) => s.members === 5), 20_000, 'departure noticed')
  console.log(`departure noticed by everyone after ${Date.now() - t1} ms`)
  await expect(owner.getByTestId('member-count')).toHaveText('5')
})

test('the lobby carries on without its owner, and the owner can rejoin', async ({ browser }) => {
  test.setTimeout(120_000)
  const seed = `e2e-away-${Date.now()}`
  const owner = await openOwner(browser, seed)
  const a = await openMember(browser, seed, 'a')
  await waitFor(() => meshSnapshot(a), (s) => s.members === 2, 30_000, 'a joined')
  await owner.close()
  await expect(a.getByTestId('owner-away')).toBeVisible({ timeout: 15_000 })

  // A newcomer still gets in through the remaining door peer.
  const b = await openMember(browser, seed, 'b')
  await waitFor(() => all([a, b]), (ss) => ss.every((s) => s.members === 2 && s.openLinks === 1), 30_000, 'b joined via a')

  // The owner comes back (same seed, same key) and everyone sees it.
  const back = await owner.context().newPage()
  const { TRACKER_URL } = await import('../playwright.config')
  await back.goto(`/#/host?${new URLSearchParams({ stream: seed, tracker: TRACKER_URL, ice: 'none', name: 'owner' })}`)
  await waitFor(() => all([a, b]), (ss) => ss.every((s) => s.members === 3), 30_000, 'owner back')
  await expect(a.getByTestId('owner-away')).toBeHidden()
})

test('while the owner streams, the mesh link stays up and chat flows both ways', async ({ browser }) => {
  test.setTimeout(90_000)
  const seed = `e2e-streamchat-${Date.now()}`
  const owner = await openHost(browser, seed, { k: 1, m: 0 })
  const viewer = await openMember(browser, seed, 'v')
  await waitFor(() => viewerSnapshot(viewer), (s) => s.decoded > 30, 30_000, 'frames')
  // Streaming load used to make the old host heartbeat miss a ping and tear the mesh link down.
  await new Promise((r) => setTimeout(r, 6000))
  const [o, v] = await Promise.all([meshSnapshot(owner), meshSnapshot(viewer)])
  expect(o.openLinks).toBe(1)
  expect(v.openLinks).toBe(1)
  await expect(viewer.getByTestId('owner-away')).toBeHidden()
  await expect(viewer.getByTestId('lobby-name')).toHaveText("owner's lobby")

  await viewer.getByTestId('chat-input').fill('hi owner')
  await viewer.getByTestId('chat-send').click()
  await owner.getByTestId('chat-input').fill('hi viewer')
  await owner.getByTestId('chat-send').click()
  await waitFor(
    () => Promise.all([meshSnapshot(owner), meshSnapshot(viewer)]),
    (ss) => ss.every((s) => s.chat.includes('v: hi owner') && s.chat.includes('owner: hi viewer')),
    10_000,
    'chat both ways',
  )
})
