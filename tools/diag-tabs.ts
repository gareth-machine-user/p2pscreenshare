// Congestion diagnostic with real background tabs: a presenter and a viewer in one headed Chromium
// (two windows: separate profiles), either one behind another tab of its window, so it is hidden
// (and throttled) the way a user's presenter tab is while they show another window. Playwright
// can't do this (it emulates focus, so every page it drives reports itself visible): this drives
// Chromium over raw CDP instead. Needs a display; on a headless machine run it under Xvfb:
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" npx tsx tools/diag-tabs.ts
//
// Environment: CHROMIUM_PATH (required), CHROMIUM_LD_PRELOAD, E2E_APP_PORT / E2E_TRACKER_PORT
// (servers are started unless already listening), DIAG_PRESET (ultra | hi | 4k | auto),
// DIAG_SECONDS, DIAG_HIDDEN (host: the presenter's tab is behind
// another tab of its window, the default; viewer: the viewer's is; none: both in front), DIAG_PATTERN (busy, the default; bursty; bars), DIAG_SOURCE=screen (capture the
// virtual screen instead of the test pattern), DIAG_OUT (JSON of every sample).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostIdentity } from '../src/net/lobby'
import { DIAG_PRESETS, formatTimeline, hostSampleExpr, INSTALL_LAG, viewerSampleExpr, type DiagRow } from '../e2e/diag'

const APP_PORT = Number(process.env.E2E_APP_PORT) || 5179
const TRACKER_PORT = Number(process.env.E2E_TRACKER_PORT) || 8765
const CDP_PORT = 9400 + Math.floor(Math.random() * 400)
const seconds = Number(process.env.DIAG_SECONDS ?? 75)
const presetName = process.env.DIAG_PRESET ?? 'ultra'
const preset = DIAG_PRESETS[presetName]
const hidden = (process.env.DIAG_HIDDEN ?? 'host') as 'host' | 'viewer' | 'none'
const screen = process.env.DIAG_SOURCE === 'screen'
const children: ChildProcess[] = []
let profile: string | null = null

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' })
    s.once('connect', () => (s.end(), resolve(true)))
    s.once('error', () => resolve(false))
  })
}

async function ensureServer(port: number, cmd: string[]): Promise<void> {
  if (await listening(port)) return
  children.push(spawn('npx', cmd, { stdio: 'ignore' }))
  for (let i = 0; i < 120 && !(await listening(port)); i++) await sleep(500)
}

/** A minimal CDP client for one page target. */
class Page {
  private ws: WebSocket
  private seq = 0
  private waiting = new Map<number, (v: any) => void>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.id !== undefined) this.waiting.get(msg.id)?.(msg)
    }
  }

  static async connect(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl)
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
    return new Page(ws)
  }

  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve) => {
      this.waiting.set(id, (m) => (this.waiting.delete(id), resolve(m)))
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval<T = any>(expression: string): Promise<T> {
    const m = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))
    return m.result?.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

async function waitEval<T>(page: Page, expr: string, ok: (v: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const t0 = Date.now()
  let last: T | undefined
  while (Date.now() - t0 < timeoutMs) {
    try {
      last = await page.eval<T>(expr)
      if (ok(last)) return last
    } catch {
      // not ready yet
    }
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function main(): Promise<void> {
  if (!preset) throw new Error(`unknown DIAG_PRESET ${presetName}`)
  const chromium = process.env.CHROMIUM_PATH
  if (!chromium) throw new Error('CHROMIUM_PATH is required')
  await ensureServer(TRACKER_PORT, ['tsx', 'tools/tracker.ts', '--port', String(TRACKER_PORT)])
  await ensureServer(APP_PORT, ['vite', '--port', String(APP_PORT), '--strictPort'])

  const seed = `diag-tabs-${Date.now()}`
  const tracker = `ws://localhost:${TRACKER_PORT}`
  const hostQ = new URLSearchParams({
    source: 'test',
    k: '4',
    m: '1',
    bitrate: String(preset.bitrate),
    audio: '0',
    mic: '0',
    quality: presetName === 'auto' ? 'auto' : 'fixed',
    share: '1',
    res: preset.res,
    stream: seed,
    tracker,
    ice: 'none',
    name: 'owner',
  })
  if (process.env.DIAG_PATTERN !== 'bars') hostQ.set('pattern', process.env.DIAG_PATTERN === 'bursty' ? 'bursty' : 'busy')
  // A real capture of the (virtual) screen, which shows the viewer's window playing the stream.
  if (screen) hostQ.delete('source')
  const { joinCode } = await hostIdentity(seed)
  const viewerQ = new URLSearchParams({ tracker, name: 'v', ice: 'none' })
  const base = `http://localhost:${APP_PORT}`
  const hostUrl = `${base}/#/host?${hostQ}`
  const viewerUrl = `${base}/#/lobby/${joinCode}?${viewerQ}`

  profile = mkdtempSync(join(tmpdir(), 'diag-tabs-'))
  const browser = spawn(
    chromium,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--window-size=1600,1000',
      ...(screen ? ['--auto-select-desktop-capture-source=Entire screen', '--auto-accept-this-tab-capture'] : []),
      'about:blank',
    ],
    { env: { ...process.env, ...(process.env.CHROMIUM_LD_PRELOAD ? { LD_PRELOAD: process.env.CHROMIUM_LD_PRELOAD } : {}) }, stdio: 'ignore' },
  )
  children.push(browser)
  const cdp = `http://127.0.0.1:${CDP_PORT}`
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${cdp}/json/version`).then((r) => r.ok).catch(() => false)) break
    await sleep(250)
  }
  const version = await (await fetch(`${cdp}/json/version`)).json()
  const browserCdp = await Page.connect(version.webSocketDebuggerUrl)
  const blank = (await (await fetch(`${cdp}/json`)).json()).find((t: any) => t.type === 'page')

  /** Opens `url` in a browser context (a new window for a new context), as its front tab. */
  const open = async (url: string, browserContextId?: string): Promise<Page> => {
    const r = await browserCdp.send('Target.createTarget', { url, ...(browserContextId ? { browserContextId } : {}) })
    const id = r.result.targetId
    const t = (await (await fetch(`${cdp}/json`)).json()).find((x: any) => x.id === id)
    return Page.connect(t.webSocketDebuggerUrl)
  }
  // The presenter in the default profile, the viewer in a separate (incognito-like) one: one profile
  // would give both tabs the same identity. A blank tab opened after a page hides it.
  const viewerCtx = (await browserCdp.send('Target.createBrowserContext')).result.browserContextId as string
  const host = await open(hostUrl)
  if (hidden === 'host') await open('about:blank')
  const viewer = await open(viewerUrl, viewerCtx)
  if (hidden === 'viewer') await open('about:blank', viewerCtx)
  if (blank) await fetch(`${cdp}/json/close/${blank.id}`).catch(() => {})

  const state = `(() => { const p = window.__p2p; if (!p) return { url: location.href, session: false }; return { vis: document.visibilityState, joined: p.mesh.joined, links: [...p.mesh.conns.keys()].length, publishing: !!p.publishing, codec: p.publishing ? p.publishing.codec : null, enc: p.encoderStatsNow, viewer: p.debugViewer() } })()`
  try {
    await waitEval(viewer, 'window.__p2p ? window.__p2p.debugViewer().decoded : 0', (n: number) => n > 30, 90_000, 'viewer playing')
  } catch (e) {
    console.log('host:', JSON.stringify(await host.eval(state).catch((x) => String(x))))
    console.log('viewer:', JSON.stringify(await viewer.eval(state).catch((x) => String(x))))
    throw e
  }
  const viewerId = await viewer.eval<string>('window.__p2p.selfId')
  const hostId = await host.eval<string>('window.__p2p.selfId')
  await host.eval(INSTALL_LAG)
  await viewer.eval(INSTALL_LAG)
  console.log(`visibility: host ${await host.eval('document.visibilityState')}, viewer ${await viewer.eval('document.visibilityState')}`)

  const rows: DiagRow[] = []
  const t0 = Date.now()
  for (let i = 0; i < seconds; i++) {
    const tick = Date.now()
    const [h, v] = await Promise.all([host.eval(hostSampleExpr(viewerId)), viewer.eval(viewerSampleExpr(hostId))])
    const prev = rows.at(-1)
    rows.push({ t: Math.round((Date.now() - t0) / 100) / 10, h, v })
    if (prev && h.kbps !== prev.h.kbps) console.log(`[${rows.at(-1)!.t}s] bitrate ${prev.h.kbps} -> ${h.kbps}: ${h.ccReason}`)
    await sleep(Math.max(0, 1000 - (Date.now() - tick)))
  }
  console.log(`preset ${presetName} (${preset.bitrate} kbps ${preset.res}), ${seconds} s, hidden: ${hidden}`)
  console.log(formatTimeline(rows))
  if (process.env.DIAG_OUT) writeFileSync(process.env.DIAG_OUT, JSON.stringify({ preset: presetName, hidden, rows }, null, 1))
  host.close()
  viewer.close()
  browserCdp.close()
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => {
    for (const c of children) c.kill()
    if (profile) setTimeout(() => rmSync(profile!, { recursive: true, force: true }), 1000)
  })
