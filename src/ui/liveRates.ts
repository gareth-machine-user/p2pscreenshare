// Live bandwidth figures for the UI: what is being sent and received right now, as opposed to the
// upload estimate from the last probe. Rates are per second over the 2 s sampling window (getStats
// polls, uplink counters), so they don't flicker. Pure, for unit tests.
import type { LinkRow } from '../session/peerSession'
import { fmtKbps, fmtMs } from './route'

/** A live rate in Mbps (one decimal; two below 1 Mbps so small rates don't read as 0). */
export function fmtMbps(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps)) return '—'
  const mbps = Math.max(0, kbps) / 1000
  return `${mbps < 1 && mbps > 0 ? mbps.toFixed(2) : mbps.toFixed(1)} Mbps`
}

/** Sum of the known rates; null when none is known. */
export function sumKbps(xs: (number | null | undefined)[]): number | null {
  let out: number | null = null
  for (const x of xs) if (x !== null && x !== undefined && Number.isFinite(x)) out = (out ?? 0) + x
  return out
}

/** One peer's live figures from its connections (Peers panel). */
export interface PeerLive {
  sendKbps: number | null
  recvKbps: number | null
  /** Path RTT now and its baseline: the mesh link's (lane 0), else the first connection with one. */
  rttMs: number | null
  baselineMs: number | null
  /** Per-connection breakdown, for a tooltip. */
  breakdown: string
}

export function peerLive(links: LinkRow[]): PeerLive {
  const withRtt = links.find((l) => l.lane === 0 && l.rttMs !== null) ?? links.find((l) => l.rttMs !== null)
  return {
    sendKbps: sumKbps(links.map((l) => l.sendKbps)),
    recvKbps: sumKbps(links.map((l) => l.recvKbps)),
    rttMs: withRtt?.rttMs ?? null,
    baselineMs: withRtt?.baselineMs ?? null,
    breakdown: links
      .map((l) => `${l.lane === 0 ? 'mesh link' : `lane ${l.lane}`}: ↑ ${fmtKbps(l.sendKbps)} ↓ ${fmtKbps(l.recvKbps)}, RTT ${fmtMs(l.rttMs)}`)
      .join('\n'),
  }
}

/** The presenter's live upload badge: its rate, and a warning when the uplink holds the bitrate down. */
export function uploadBadge(o: {
  sendKbps: number | null
  /** The uplink counts as full (most peers congested over queueing paths). */
  full: boolean
  /** Why the bitrate is below the chosen quality (clampText), if it is. */
  clamp: string | null
  /** The congestion controller's last move. */
  ccReason: string | null
}): { text: string; warn: boolean; title: string } {
  const warn = o.full || o.clamp !== null
  const why = o.clamp ?? (o.full ? (o.ccReason ?? 'Your uplink is congested') : null)
  return {
    text: `Uploading ${fmtMbps(o.sendKbps)}`,
    warn,
    title: why ? `Live upload (all connections, last 2 s). ${why}` : 'Live upload (all connections, last 2 s)',
  }
}
