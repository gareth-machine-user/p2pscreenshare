<script lang="ts">
  import { fmtKbps } from '../route'
  import { describeQuality, type VideoQuality } from '../../media/quality'
  import Icon from './Icon.svelte'
  import QualityPicker from './QualityPicker.svelte'

  let {
    audio,
    viewers = null,
    limited = null,
    clamp = null,
    uploading = null,
    uploadFraction = null,
    auto = false,
    quality = $bindable(),
    autoLower = $bindable(),
    nativeSize,
    facing = null,
    onflip,
    onmic,
    onsystem,
    onswitch,
    onquality,
    onstop,
  }: {
    audio: { system: boolean; mic: boolean; systemMuted: boolean; micMuted: boolean }
    /** How many are watching, if known. */
    viewers?: number | null
    /** Set while the audience's upload can't carry the stream. */
    limited?: { feasibleKbps: number } | null
    /** Why the bitrate is below the chosen quality, if it is (ui/rateText.ts). */
    clamp?: string | null
    /** Live upload figure (ui/liveRates.ts uploadBadge). */
    uploading?: { text: string; warn: boolean; title: string } | null
    /** Live upload as a share of what the uplink carries (0–1), if both are known. */
    uploadFraction?: number | null
    /** Auto quality will lower the bitrate by itself. */
    auto?: boolean
    quality: VideoQuality
    autoLower: boolean
    nativeSize?: [number, number]
    /** The camera in use, when sharing a camera (null for a screen). */
    facing?: 'user' | 'environment' | null
    onflip?: () => void
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

<!-- Why the stream is below the chosen quality, in one place above the bar. -->
{#if clamp || limited}
  <div class="presenter-status" role="status">
    <Icon name="alert" size={17} />
    <span>
      {#if limited}
        <span data-testid="audience-limited">Your audience can carry about {fmtKbps(limited.feasibleKbps)}, {auto ? 'so quality is being lowered to keep playback smooth' : 'so some viewers may stutter'}.</span>
      {/if}
      {#if clamp}
        <span data-testid="bitrate-clamp">{clamp}</span>
      {/if}
    </span>
  </div>
{/if}

<div class="presenter-bar" data-testid="presenter-bar">
  <span class="live-pill">Live{#if viewers !== null}<span data-testid="viewer-total">· {viewers} watching</span>{/if}</span>
  <span class="sep"></span>
  {#if audio.mic}
    <button data-testid="mute-mic" aria-pressed={audio.micMuted} onclick={() => onmic(!audio.micMuted)} title={audio.micMuted ? 'Unmute your mic' : 'Mute your mic'}>
      <Icon name={audio.micMuted ? 'micOff' : 'mic'} />{audio.micMuted ? 'Mic off' : 'Mic on'}
    </button>
  {/if}
  {#if audio.system}
    <button data-testid="mute-system" aria-pressed={audio.systemMuted} onclick={() => onsystem(!audio.systemMuted)} title={audio.systemMuted ? 'Share the sound again' : 'Stop sharing the sound'}>
      <Icon name={audio.systemMuted ? 'muted' : 'volume'} />{audio.systemMuted ? 'Sound off' : 'Sound on'}
    </button>
  {:else if !facing}
    <span class="hint" data-testid="no-system-audio" title="The browser gave no audio for this source (common for windows, and on macOS and Linux)">No system audio</span>
  {/if}
  {#if facing && onflip}
    <button data-testid="flip-camera" onclick={onflip} title="Switch between the front and back cameras">
      <Icon name="flip" />{facing === 'user' ? 'Back camera' : 'Front camera'}
    </button>
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
      {describeQuality(quality, nativeSize)}<Icon name="chevronDown" size={14} />
    </button>
    {#if qualityOpen}
      <div class="quality-panel" data-testid="presenter-quality-panel">
        <QualityPicker bind:quality bind:autoLower {nativeSize} onchange={onquality} />
        {#if clamp}<p class="hint warn-text">{clamp}</p>{/if}
      </div>
    {/if}
  </div>
  <span class="spacer"></span>
  {#if uploading}
    <span class="upload-meter" class:warn={uploading.warn} title={uploading.title}>
      <span data-testid="live-upload">{uploading.text}</span>
      {#if uploadFraction !== null}<span class="meter" aria-hidden="true"><i style:width="{Math.round(Math.min(1, uploadFraction) * 100)}%"></i></span>{/if}
    </span>
  {/if}
  <button class="danger" data-testid="stop-share" onclick={onstop}><Icon name="stop" size={14} />Stop sharing</button>
</div>
