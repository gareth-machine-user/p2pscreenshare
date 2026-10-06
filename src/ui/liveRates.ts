// Live bandwidth figures for the UI: what is being sent and received right now, as opposed to the
// measured capacity (session/capacity.ts). Rates are per second over the 2 s sampling window (getStats
// polls, uplink counters), so they don't flicker. Pure, for unit tests.
import type { LinkRow, PeerSession } from '../session/peerSession'
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
  /** What your connections to it carry together (session/capacity.ts), and whether that was its own limit. */
  capKbps: number | null
  bound: boolean
  /** Some connection to it stalled in the last window. */
  stalled: boolean
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
    capKbps: sumKbps(links.map((l) => l.capKbps)),
    bound: links.some((l) => l.bound),
    stalled: links.some((l) => l.stalled),
    breakdown: links
      .map((l) => `${l.lane === 0 ? 'mesh link' : `lane ${l.lane}`}: ↑ ${fmtKbps(l.sendKbps)} ↓ ${fmtKbps(l.recvKbps)}, RTT ${fmtMs(l.rttMs)}${l.stalled ? ', stalled' : ''}`)
      .join('\n'),
  }
}

/** A lobby member as gossip describes it. */
export interface MemberInfo {
  id: string
  name: string
  joinedAt: number
  /** Its uplink's measured capacity, as it gossips it (not current use). */
  capacityKbps: number | null
}

/** One member's row: its estimated upload, and (when directly connected) live rates to and from it. */
export interface LivePeerRow extends PeerLive {
  id: string
  name: string
  self: boolean
  estKbps: number | null
  /** Connections to it (getStats rows); empty for yourself or members you have no link to. */
  links: LinkRow[]
  /** You have an open connection with live stats to it. */
  direct: boolean
}

/**
 * Every member in join order, yourself included (Peers panel, Stats): estimated upload from its
 * gossiped capacity, live sending / receiving / RTT from this peer's own per-connection stats. Your
 * own row carries your totals.
 */
export function livePeers(o: {
  selfId: string
  members: MemberInfo[]
  linksFor: (id: string) => LinkRow[]
  totals: { sendKbps: number | null; recvKbps: number | null }
}): LivePeerRow[] {
  return [...o.members]
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
    .map((m) => {
      const self = m.id === o.selfId
      const links = self ? [] : o.linksFor(m.id)
      const live = self
        ? { sendKbps: o.totals.sendKbps, recvKbps: o.totals.recvKbps, rttMs: null, baselineMs: null, capKbps: null, bound: false, stalled: false, breakdown: 'Your totals across all connections' }
        : peerLive(links)
      return { id: m.id, name: m.name || m.id.slice(0, 6), self, estKbps: m.capacityKbps, links, direct: links.length > 0, ...live }
    })
}

/** livePeers for a running session: every member, with this peer's per-connection stats. */
export function sessionPeers(s: PeerSession): LivePeerRow[] {
  return livePeers({
    selfId: s.mesh.selfId,
    members: [s.mesh.record, ...s.mesh.members()],
    linksFor: (id) => s.linkStatsFor(id),
    totals: s.liveRates(),
  })
}

/** The presenter's live upload badge: its rate, and a warning while the bitrate is held below the chosen quality. */
export function uploadBadge(o: {
  sendKbps: number | null
  /** The uplink's measured capacity (session/capacity.ts), if known. */
  capacityKbps: number | null
  /** Why the bitrate is below the chosen quality (ui/rateText.ts), if it is. */
  rate: string | null
  /** This computer can't keep up (PeerSession.localLoad), if so. */
  local?: { stallMs: number; encoderDroppedFps: number } | null
}): { text: string; warn: boolean; title: string } {
  const local = o.local ? localLoadText(o.local) : null
  const parts = ['Live upload (all connections, last 2 s).']
  if (o.capacityKbps !== null) parts.push(`Your upload carries about ${fmtMbps(o.capacityKbps)}.`)
  if (o.rate) parts.push(o.rate)
  if (local) parts.push(local)
  return { text: `Uploading ${fmtMbps(o.sendKbps)}`, warn: o.rate !== null || local !== null, title: parts.join(' ') }
}

/** Why this computer can't keep up, in words (not the network: a lower bitrate wouldn't help it). */
export function localLoadText(l: { stallMs: number; encoderDroppedFps: number }): string {
  const parts: string[] = []
  if (l.encoderDroppedFps > 0) parts.push(`the encoder is dropping ${l.encoderDroppedFps} frames/s`)
  if (l.stallMs > 0) parts.push(`the page stalled for ${(l.stallMs / 1000).toFixed(1)} s`)
  return `Your computer can't keep up (${parts.join(', ')}): this is not the network.`
}
