// The presenter's bitrate and what sets it, in plain words (presenter bar, Stats). Pure.
import type { PeerSession } from '../session/peerSession'

export type RateStatus = NonNullable<ReturnType<PeerSession['rateStatus']>>

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(kbps < 10_000 ? 1 : 0)} Mbps`

/** What limits the bitrate, as a short phrase. */
export function rateReason(r: RateStatus): string {
  switch (r.limit) {
    case 'uplink':
      return `limited by your upload: ~${mbps(r.uplinkKbps ?? 0)}`
    case 'viewers':
      return `limited by viewers' connections: median ~${mbps(r.medianPeerKbps ?? 0)}`
    case 'audience':
      return 'limited by audience relay capacity'
    case 'unmeasured':
      return 'starting gently until your upload is measured'
    case 'chosen':
      return r.currentKbps < r.chosenKbps ? 'rising back to the chosen quality' : 'at chosen quality'
  }
}

/** Why the bitrate is below the chosen quality, as one sentence; null at the chosen quality. */
export function rateText(r: RateStatus): string | null {
  if (r.currentKbps >= r.chosenKbps) return null
  const tail = r.limit === 'uplink' || r.limit === 'viewers' ? ' A lower quality preset or fewer parity stripes would look sharper than a starved stream.' : ''
  return `Bitrate ${mbps(r.currentKbps)} of ${mbps(r.chosenKbps)}: ${rateReason(r)}.${tail}`
}
