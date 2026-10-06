import { defineConfig } from '@playwright/test'

const TRACKER_PORT = 8765
const APP_PORT = 5179

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    launchOptions: {
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
