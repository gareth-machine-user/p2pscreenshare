<script lang="ts">
  import type { EncoderRates, LossRates, UplinkRates } from '../../proto/messages'
  import { fmtKbps, fmtMs } from '../route'

  let {
    loss = null,
    renderedFps = null,
    uplink = null,
    encoder = null,
    adapting = null,
    stalledLanes = 0,
    clamp = null,
  }: {
    loss?: LossRates | null
    renderedFps?: number | null
    uplink?: UplinkRates | null
    encoder?: EncoderRates | null
    /** What sets the presenter's bitrate (ui/rateText.ts). */
    adapting?: string | null
    /** The presenter's connections that stalled in the last window. */
    stalledLanes?: number
    /** Why the bitrate is below the chosen quality, if it is. */
    clamp?: string | null
  } = $props()

  const n = (x: number) => (x === 0 ? '0' : x < 10 ? x.toFixed(1) : Math.round(x).toString())
  const warn = (x: number) => x > 0.5
</script>

<!-- Where frames go missing, per second over the last 2 s. -->
<div class="frame-stats" data-testid="frame-stats">
  {#if encoder}
    <h4>Encoder</h4>
    <div class="stats-grid" data-testid="encoder-stats">
      <div><span>Codec</span><b>{encoder.codec ?? '—'}</b></div>
      <div><span>Bitrate (target / max)</span><b>{fmtKbps(encoder.kbps)} ({fmtKbps(encoder.targetKbps)} / {fmtKbps(encoder.ceilingKbps)})</b></div>
      <div><span>Captured → encoded fps</span><b>{n(encoder.captureFps)} → {n(encoder.encodedFps)}</b></div>
      <div><span>Dropped by encoder /s</span><b class:warn={warn(encoder.droppedFps)} data-testid="encoder-dropped">{n(encoder.droppedFps)}</b></div>
      <div><span>Encode time</span><b>{fmtMs(encoder.encodeMs)}</b></div>
      <div><span>Biggest frame</span><b>{n(encoder.maxFrameKB)} KB</b></div>
      <div><span>Keyframes /s</span><b>{n(encoder.keyframes)}</b></div>
      {#if adapting}<div><span>Bitrate</span><b data-testid="cc-reason">{adapting}</b></div>{/if}
      {#if stalledLanes > 0}<div><span>Stalled connections</span><b class="warn" title="Their send buffers stopped draining (an SCTP stall): their stripes moved to another connection meanwhile" data-testid="stalled-lanes">{stalledLanes} stalled</b></div>{/if}
    </div>
    {#if clamp}<p class="hint warn" data-testid="clamp-explained">{clamp}</p>{/if}
  {/if}
  {#if loss}
    <h4>Playback</h4>
    <div class="stats-grid" data-testid="loss-stats">
      <div><span>Frames in → shown /s</span><b>{n(loss.incomingFps)} → {renderedFps ?? '—'}</b></div>
      <div><span>Incomplete /s</span><b class:warn={warn(loss.incomplete)} title="Never got enough pieces: fragments lost or dropped upstream">{n(loss.incomplete)}</b></div>
      <div><span>Late /s</span><b class:warn={warn(loss.late)} title="Arrived after their play time">{n(loss.late)}</b></div>
      <div><span>Undecodable /s</span><b class:warn={warn(loss.undecodable)} title="Their reference frame was missing">{n(loss.undecodable)}</b></div>
      <div><span>Skipped /s</span><b class:warn={warn(loss.skipped)} title="Given up on while waiting for a missing frame">{n(loss.skipped)}</b></div>
      <div><span>Not shown /s</span><b class:warn={warn(loss.notRendered)} title="Decoded but replaced by a newer frame before display">{n(loss.notRendered)}</b></div>
    </div>
  {/if}
  {#if uplink}
    <h4>Your uplink</h4>
    <div class="stats-grid" data-testid="uplink-stats">
      <div><span>Sending</span><b>{fmtKbps(uplink.kbps)}</b></div>
      <div><span>Dropped T0 / T1 / T2 /s</span><b class:warn={warn(uplink.drops[0] + uplink.drops[1] + uplink.drops[2])} title="Fragments that missed their queueing deadline (900 / 350 / 180 ms)">{n(uplink.drops[0])} / {n(uplink.drops[1])} / {n(uplink.drops[2])}</b></div>
      <div><span>Queueing delay</span><b>{fmtMs(uplink.queueMs)}</b></div>
      <div><span>Send-buffer stalls /s</span><b class:warn={warn(uplink.stalls)}>{n(uplink.stalls)}</b></div>
    </div>
  {/if}
</div>
