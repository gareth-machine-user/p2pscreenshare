<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Player } from '../../media/player'
  import type { ViewQuality } from '../settings.svelte'
  import Icon from './Icon.svelte'

  let {
    player = null,
    localStream = null,
    message = null,
    hasAudio = false,
    muted = $bindable(true),
    quality = $bindable<ViewQuality>('auto'),
    qualityOptions = null,
    panel,
  }: {
    /** Remote stream to draw. */
    player?: Player | null
    /** The presenter's own capture, shown instead of a remote stream. */
    localStream?: MediaStream | null
    message?: string | null
    hasAudio?: boolean
    muted?: boolean
    quality?: ViewQuality
    /** Quality choices for this stream, or null to hide the control. */
    qualityOptions?: ViewQuality[] | null
    /** Contents of the gear panel. */
    panel?: Snippet
  } = $props()

  let stage: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let video: HTMLVideoElement | undefined = $state()
  let gearOpen = $state(false)
  /** Touch devices have no hover: a tap toggles the overlay. */
  let touched = $state(false)
  let fullscreen = $state(false)

  $effect(() => {
    player?.setCanvas(canvas ?? null)
    return () => player?.setCanvas(null)
  })

  $effect(() => {
    if (video) video.srcObject = localStream
  })

  $effect(() => {
    const onChange = () => (fullscreen = document.fullscreenElement === stage)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  })

  function toggleMute() {
    muted = !muted
    player?.audio.setMuted(muted)
  }

  function toggleFullscreen() {
    // The stage container (not the canvas) goes fullscreen, so the overlay stays visible.
    if (document.fullscreenElement) void document.exitFullscreen()
    else void stage?.requestFullscreen()
  }

  const QUALITY_LABELS: Record<ViewQuality, string> = { auto: 'Auto', full: 'Full', preview: 'Preview' }
</script>

<div
  class="stage"
  class:touched
  class:fullscreen
  bind:this={stage}
  data-testid="stage"
  role="presentation"
  onpointerdown={(e) => {
    if (e.pointerType === 'touch' && e.target === e.currentTarget) touched = !touched
  }}
>
  {#if localStream}
    <video bind:this={video} autoplay muted playsinline data-testid="local-preview"></video>
  {:else}
    <canvas bind:this={canvas} data-testid="video"></canvas>
  {/if}
  {#if message}
    <div class="overlay-msg" data-testid="stage-message">{message}</div>
  {/if}

  <div class="player-overlay" data-testid="player-overlay">
    {#if hasAudio && !localStream}
      <button data-testid="mute" aria-pressed={!muted} onclick={toggleMute} title={muted ? 'Unmute' : 'Mute'}>
        <Icon name={muted ? 'muted' : 'volume'} />{muted ? 'Unmute' : 'Mute'}
      </button>
    {/if}
    {#if qualityOptions}
      <select data-testid="quality" bind:value={quality} aria-label="Quality">
        {#each qualityOptions as q}<option value={q}>{QUALITY_LABELS[q]}</option>{/each}
      </select>
    {/if}
    <span class="spacer"></span>
    {#if panel}
      <button data-testid="gear" aria-expanded={gearOpen} onclick={() => (gearOpen = !gearOpen)} title="Stats and details"><Icon name="gear" /></button>
    {/if}
    <button data-testid="fullscreen" onclick={toggleFullscreen} title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
      <Icon name={fullscreen ? 'shrink' : 'expand'} />
    </button>
  </div>

  {#if gearOpen && panel}
    <div class="gear-panel" data-testid="gear-panel">
      {@render panel()}
    </div>
  {/if}
</div>
