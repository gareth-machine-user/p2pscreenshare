import type { Browser, Page } from '@playwright/test'
import { TRACKER_URL } from '../playwright.config'
import { hostIdentity } from '../src/net/lobby'

export interface HostOpts {
  k: number
  m: number
  bitrate?: number
  up?: number
  res?: string
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
    audio: '0',
    autostart: '1',
    res: o.res ?? '640x360',
    stream: streamId,
    tracker: TRACKER_URL,
    ice: 'none',
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
  await page.goto(`/#/watch/${joinCode}?${q}`)
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
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = window.__p2p as any
    const p = s.player.stats
    return {
      id: s.selfId,
      state: s.state,
      decoded: p.decodedFrames,
      dropped: p.droppedFrames,
      fps: p.fps,
      latencyMs: p.latencyMs,
      bufferMs: p.bufferMs,
      home: s.home,
      parents: [...s.parents],
      children: s.relay.allChildren().size,
      childIds: [...s.relay.allChildren()],
      probeKbps: s.probeKbps,
      waitingForKeyframe: p.waitingForKeyframe,
    }
  })
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
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = window.__p2p as any
    return {
      id: s.selfId,
      peers: s.peers.size,
      hostChildren: s.relay.allChildren().size,
      overcommitted: s.lastPlan?.overcommitted ?? 0,
      changes: s.totalChanges,
      health: Object.fromEntries(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [...s.peers.values()].map((p: any) => [p.id, { failures: p.failures, avoid: [...p.avoid.keys()] }]),
      ),
      topology: JSON.parse(JSON.stringify(s.topology)),
    }
  })
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
