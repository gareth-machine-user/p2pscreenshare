<script lang="ts">
  import { fmtKbps } from '../route'
  import { describeQuality, type VideoQuality } from '../../media/quality'
  import Icon from './Icon.svelte'
  import QualityPicker from './QualityPicker.svelte'

  let {
    audio,
    limited = null,
    clamp = null,
    uploading = null,
    auto = false,
    quality = $bindable(),
    autoLower = $bindable(),
    nativeSize,
    onmic,
    onsystem,
    onswitch,
    onquality,
    onstop,
  }: {
    audio: { system: boolean; mic: boolean; systemMuted: boolean; micMuted: boolean }
    /** Set while the audience's upload can't carry the stream. */
    limited?: { feasibleKbps: number } | null
    /** Why the bitrate is below the chosen quality, if it is (ui/rateText.ts). */
    clamp?: string | null
    /** Live upload figure (ui/liveRates.ts uploadBadge). */
    uploading?: { text: string; warn: boolean; title: string } | null
    /** Auto quality will lower the bitrate by itself. */
    auto?: boolean
    quality: VideoQuality
    autoLower: boolean
    nativeSize?: [number, number]
    onmic: (muted: boolean) => void
    onsystem: (muted: boolean) => void
    onswitch: () => void
    /** Applies the (bound) quality to the live stream. */
    onquality: () => void
    onstop: () => void
  } = $props()

  let qualityOpen = $state(false)
  let wrap: HTMLDivElement | undefined = $state()

  // Closes the quality panel on a click outside it, or Escape.
  $effect(() => {
    if (!qualityOpen) return
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap?.contains(e.target as Node)) qualityOpen = false
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  })
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
  <div class="quality-wrap" bind:this={wrap}>
    <button
      data-testid="presenter-quality"
      class:warn={!!clamp}
      aria-expanded={qualityOpen}
      title={clamp ?? 'Resolution, frame rate and quality'}
      onclick={() => (qualityOpen = !qualityOpen)}
    >
      <Icon name="gear" />{describeQuality(quality, nativeSize)}
    </button>
    {#if qualityOpen}
      <div class="quality-panel" data-testid="presenter-quality-panel">
        <QualityPicker bind:quality bind:autoLower {nativeSize} onchange={onquality} />
        {#if clamp}<p class="hint warn-text">{clamp}</p>{/if}
      </div>
    {/if}
  </div>
  {#if uploading}
    <span class="badge live-upload" class:warn={uploading.warn} data-testid="live-upload" title={uploading.title}>{uploading.text}</span>
  {/if}
  <span class="spacer"></span>
  {#if clamp}
    <span class="badge warn clamp" data-testid="bitrate-clamp">{clamp}</span>
  {/if}
  {#if limited}
    <span class="badge warn" data-testid="audience-limited">
      Audience upload is limited: about {fmtKbps(limited.feasibleKbps)} will play smoothly{auto ? ' (adjusting)' : ''}
    </span>
  {/if}
  <button class="danger" data-testid="presenter-stop" onclick={onstop}><Icon name="stop" />Stop</button>
</div>
