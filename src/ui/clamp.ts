import type { PeerSession } from '../session/peerSession'

type Clamp = NonNullable<ReturnType<PeerSession['bitrateClamp']>>

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(kbps < 10_000 ? 1 : 0)} Mbps`

/** Why the presenter's bitrate is below its chosen quality, as one plain sentence. */
export function clampText(c: Clamp): string {
  const head = `Bitrate lowered to ${mbps(c.currentKbps)} of ${mbps(c.ceilingKbps)}`
  if (c.cause === 'audience') {
    return `${head}: the audience can't relay enough to carry more. It rises again as viewers with more upload join.`
  }
  return (
    `${head}: your upload is sending about ${mbps(c.sendingKbps)}, but ${mbps(c.ceilingKbps)} needs at least ${mbps(c.neededKbps)} here ` +
    `(you send ${c.directEdges} stripe copies yourself: all ${c.stripes} stripes, parity included, to each viewer you feed directly). ` +
    `It rises again as your connection allows; a lower quality preset or fewer parity stripes would look sharper than a starved one.`
  )
}
