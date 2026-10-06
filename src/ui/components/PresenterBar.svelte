<script lang="ts">
  import { fmtKbps } from '../route'
  import { QUALITY_PRESETS, type QualityPreset } from '../settings.svelte'
  import Icon from './Icon.svelte'

  let {
    audio,
    limited = null,
    clamp = null,
    auto = false,
    quality,
    onmic,
    onsystem,
    onswitch,
    onquality,
    onstop,
  }: {
    audio: { system: boolean; mic: boolean; systemMuted: boolean; micMuted: boolean }
    /** Set while the audience's upload can't carry the stream. */
    limited?: { feasibleKbps: number } | null
    /** Why the bitrate is below the chosen quality, if it is (overrides `limited`). */
    clamp?: string | null
    /** Auto quality will lower the bitrate by itself. */
    auto?: boolean
    quality: QualityPreset
    onmic: (muted: boolean) => void
    onsystem: (muted: boolean) => void
    onswitch: () => void
    onquality: (q: QualityPreset) => void
    onstop: () => void
  } = $props()
</script>

<div class="presenter-bar" data-testid="presenter-bar">
  <span class="live-dot">● Live</span>
  {#if audio.mic}
    <button data-testid="mute-mic" aria-pressed={audio.micMuted} onclick={() => onmic(!audio.micMuted)}>
      <Icon name={audio.micMuted ? 'micOff' : 'mic'} />{audio.micMuted ? 'Unmute mic' : 'Mute mic'}
    </button>
  {/if}
  {#if audio.system}
    <button data-testid="mute-system" aria-pressed={audio.systemMuted} onclick={() => onsystem(!audio.systemMuted)}>
      <Icon name={audio.systemMuted ? 'muted' : 'volume'} />{audio.systemMuted ? 'Unmute audio' : 'Mute audio'}
    </button>
  {:else}
    <span class="hint" data-testid="no-system-audio" title="The browser gave no audio for this source (common for windows, and on macOS and Linux)">No system audio</span>
  {/if}
  <button data-testid="switch-source" onclick={onswitch}><Icon name="swap" />Switch source</button>
  <select data-testid="presenter-quality" value={quality} onchange={(e) => onquality((e.currentTarget as HTMLSelectElement).value as QualityPreset)} aria-label="Quality">
    {#each Object.entries(QUALITY_PRESETS) as [value, p]}<option {value}>{p.label}</option>{/each}
  </select>
  <span class="spacer"></span>
  {#if clamp}
    <span class="badge warn clamp" data-testid="bitrate-clamp">{clamp}</span>
  {:else if limited}
    <span class="badge warn" data-testid="audience-limited">
      Audience upload is limited: about {fmtKbps(limited.feasibleKbps)} will play smoothly{auto ? ' (adjusting)' : ''}
    </span>
  {/if}
  <button class="danger" data-testid="presenter-stop" onclick={onstop}><Icon name="stop" />Stop</button>
</div>
