import type { Browser, Page } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { hostIdentity } from '../src/net/lobby'

export interface HostOpts {
  k: number
  m: number
  bitrate?: number
  up?: number
  res?: string
  /** Test-pattern tone. */
  audio?: boolean
}

/** `streamId` is the host's seed (its `stream` param); viewers join with the derived join code. */
export async function openHost(browser: Browser, streamId: string, o: HostOpts): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[host pageerror]', e.message))
  if (process.env.E2E_CONSOLE) {
    page.on('console', (m) => {
      if (!process.env.E2E_CONSOLE_FILTER || m.text().includes(process.env.E2E_CONSOLE_FILTER)) console.log(`[host ${Date.now() % 100000}]`, m.text())
    })
  }
  const q = new URLSearchParams({
    source: 'test',
    k: String(o.k),
    m: String(o.m),
    bitrate: String(o.bitrate ?? 1500),
    up: String(o.up ?? 4000),
    audio: o.audio ? '1' : '0',
    share: '1',
    res: o.res ?? '640x360',
    stream: streamId,
    tracker: TRACKER_URL,
    ice: 'none',
    name: 'owner',
  })
  await page.goto(`/#/host?${q}`)
  await page.waitForFunction(() => {
    const s = window.__p2p as { codec: string | null } | undefined
    return !!s?.codec
  })
  return page
}

export async function openViewer(browser: Browser, streamId: string, name: string, capKbps?: number): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message))
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`[${name}]`, m.text()))
  const q = new URLSearchParams({ tracker: TRACKER_URL, name, ice: 'none' })
  if (capKbps) q.set('up', String(capKbps))
  const { joinCode } = await hostIdentity(streamId)
  await page.goto(`/#/lobby/${joinCode}?${q}`)
  return page
}

export interface ViewerSnapshot {
  id: string
  state: string
  decoded: number
  dropped: number
  fps: number
  latencyMs: number | null
  bufferMs: number
  home: number | null
  parents: (string | null)[]
  children: number
  childIds: string[]
  probeKbps: number | null
  waitingForKeyframe: boolean
}

export function viewerSnapshot(page: Page): Promise<ViewerSnapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => (window.__p2p as any).debugViewer())
}

export interface HostSnapshot {
  id: string
  peers: number
  hostChildren: number
  overcommitted: number
  changes: number
  /** Per peer: rank penalty and the peers it avoids. */
  health: Record<string, { failures: number; avoid: string[] }>
  topology: { parents: Record<string, (string | null)[]>; home: Record<string, number | null> }
}

export function hostSnapshot(page: Page): Promise<HostSnapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(() => (window.__p2p as any).debugPublisher())
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  let last: T | undefined
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn()
      if (ok(last)) return last
    } catch {
      // page mid-reload or not initialised yet: retry
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Opens the owner's lobby page without sharing. */
export async function openOwner(browser: Browser, seed: string, name = 'owner'): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message))
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`[${name}]`, m.text()))
  const q = new URLSearchParams({ stream: seed, tracker: TRACKER_URL, ice: 'none', name })
  await page.goto(`/#/host?${q}`)
  return page
}

/** Opens a lobby member's page; `extra` adds URL params (e.g. `block`). */
export async function openMember(browser: Browser, seed: string, name: string, extra: Record<string, string> = {}): Promise<Page> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message))
  if (process.env.E2E_CONSOLE) page.on('console', (m) => console.log(`[${name}]`, m.text()))
  const q = new URLSearchParams({ tracker: TRACKER_URL, ice: 'none', name, ...extra })
  const { joinCode } = await hostIdentity(seed)
  await page.goto(`/#/lobby/${joinCode}?${q}`)
  return page
}

export interface MeshSnapshot {
  id: string
  name: string
  members: number
  openLinks: number
  isDoor: boolean
  unreachable: string[]
  /** Every member's gossiped record, as this peer sees it. */
  records: Record<string, { name: string; unreachable: string[] }>
  chat: string[]
}

export function meshSnapshot(page: Page): Promise<MeshSnapshot> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = window.__mesh as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recs = [m.record, ...m.members()] as any[]
    return {
      id: m.selfId,
      name: m.record.name,
      members: m.memberCount,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openLinks: [...m.conns.values()].filter((c: any) => c.isOpen).length,
      isDoor: m.isDoor,
      unreachable: [...m.record.unreachable],
      records: Object.fromEntries(recs.map((r) => [r.id, { name: r.name, unreachable: [...r.unreachable] }])),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chat: m.chat.map((c: any) => `${c.name}: ${c.text}`),
    }
  })
}
