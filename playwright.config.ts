import { statfsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

// Overridable so two checkouts can run suites side by side: servers on these ports are reused
// (reuseExistingServer), so a shared port would silently test the other checkout's code.
const TRACKER_PORT = Number(process.env.E2E_TRACKER_PORT) || 8765
const APP_PORT = Number(process.env.E2E_APP_PORT) || 5179

// Playwright launches Chromium with --disable-dev-shm-usage (for Docker's 64 MB /dev/shm), which
// puts its shared memory (video frames, IPC buffers) in files under /tmp. Where /tmp is on disk,
// nine pages of video write tens of MB/s there, and under memory pressure every renderer blocks on
// writeback for seconds at a time: all pages freeze at once and fps/latency checks fail. Keep
// shared memory in /dev/shm when it is big enough.
function devShmBytes(): number {
  try {
    const s = statfsSync('/dev/shm')
    return s.blocks * s.bsize
  } catch {
    return 0
  }
}
const USE_DEV_SHM = devShmBytes() >= 1024 ** 3

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    launchOptions: {
      ignoreDefaultArgs: USE_DEV_SHM ? ['--disable-dev-shm-usage'] : undefined,
      // On systems where Playwright's bundled browser can't run (e.g. NixOS), point at a system Chromium.
      executablePath: process.env.CHROMIUM_PATH || undefined,
      // Optional LD_PRELOAD for the browser only (see tools/nosme: ARM64 VMs that advertise but trap SME).
      env: process.env.CHROMIUM_LD_PRELOAD ? { ...process.env, LD_PRELOAD: process.env.CHROMIUM_LD_PRELOAD } : undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        // Expose real host candidates so same-machine peers connect without mDNS resolution.
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: [
    {
      command: `npx tsx tools/tracker.ts --port ${TRACKER_PORT}`,
      port: TRACKER_PORT,
      reuseExistingServer: true,
    },
    {
      command: `npx vite --port ${APP_PORT} --strictPort`,
      port: APP_PORT,
      reuseExistingServer: true,
    },
  ],
})

export const TRACKER_URL = `ws://localhost:${TRACKER_PORT}`
