<script lang="ts">
  import { canCaptureCamera, canCaptureScreen } from '../../media/capture'
  import { fmtKbps } from '../route'
  import { describeQuality, targetKbps } from '../../media/quality'
  import { nativeScreenSize } from '../screen'
  import {
    clampStripes,
    DEFAULT_SETTINGS,
    saveSettings,
    settings,
    STRIPE_LIMITS,
    supportedSource,
    type CameraFacing,
    type SourceKind,
  } from '../settings.svelte'
  import QualityPicker from './QualityPicker.svelte'

  let {
    onstart,
    oncancel,
    /** Whether the mic option is offered. */
    micSupported = false,
    title = 'Share your screen',
    action = 'Share',
  }: { onstart: () => void; oncancel: () => void; micSupported?: boolean; title?: string; action?: string } = $props()

  const s = settings.share
  const can = { screen: canCaptureScreen(), camera: canCaptureCamera() }
  s.source = supportedSource(s.source, can)
  let advanced = $state(s.source === 'test' || s.k !== DEFAULT_SETTINGS.share.k || s.m !== DEFAULT_SETTINGS.share.m)
  let dialog: HTMLDialogElement | undefined = $state()
  /** The quality picker is folded into a one-line summary until asked for. */
  let pickQuality = $state(false)
  const native = nativeScreenSize()

  $effect(() => {
    dialog?.showModal()
  })

  const SOURCES: { value: Exclude<SourceKind, 'test'>; label: string }[] = [
    ...(can.screen
      ? [
          { value: 'screen', label: 'Entire screen' },
          { value: 'window', label: 'Window' },
          { value: 'tab', label: 'Browser tab' },
        ] as const
      : []),
    ...(can.camera ? [{ value: 'camera', label: 'Camera' }] as const : []),
  ]
  const FACINGS: { value: CameraFacing; label: string }[] = [
    { value: 'user', label: 'Front' },
    { value: 'environment', label: 'Back' },
  ]

  function start(e: SubmitEvent) {
    e.preventDefault()
    s.k = clampStripes(s.k, STRIPE_LIMITS.k)
    s.m = clampStripes(s.m, STRIPE_LIMITS.m)
    saveSettings()
    dialog?.close()
    onstart()
  }

  function cancel() {
    dialog?.close()
    oncancel()
  }
</script>

<dialog bind:this={dialog} class="share-dialog" data-testid="share-dialog" oncancel={cancel}>
  <form onsubmit={start}>
    <h3>{title}</h3>
    {#if s.source !== 'test' && SOURCES.length > 1}
      <fieldset class="segmented">
        <legend>Source</legend>
        {#each SOURCES as src}
          <label class:active={s.source === src.value} data-testid="source-{src.value}">
            <input type="radio" name="source" value={src.value} bind:group={s.source} />{src.label}
          </label>
        {/each}
      </fieldset>
    {/if}
    {#if s.source === 'camera'}
      <fieldset class="segmented">
        <legend>Camera</legend>
        {#each FACINGS as f}
          <label class:active={s.facing === f.value} data-testid="facing-{f.value}">
            <input type="radio" name="facing" value={f.value} bind:group={s.facing} />{f.label}
          </label>
        {/each}
      </fieldset>
    {:else}
      <label class="check">
        <input type="checkbox" data-testid="system-audio" bind:checked={s.systemAudio} /> Share system/tab audio
      </label>
    {/if}
    {#if micSupported}
      <label class="check"><input type="checkbox" data-testid="mic" bind:checked={s.mic} /> Include microphone</label>
    {/if}
    {#if pickQuality}
      <QualityPicker bind:quality={s.video} bind:autoLower={s.autoLower} nativeSize={native} />
    {:else}
      <div class="quality-summary">
        <span class="hint">Quality</span>
        <span data-testid="quality-summary">{describeQuality(s.video, native)}{s.autoLower ? ' · lowers automatically' : ''}</span>
        <button type="button" class="link" data-testid="quality-change" onclick={() => (pickQuality = true)}>Change</button>
      </div>
    {/if}

    <details bind:open={advanced}>
      <summary>Advanced</summary>
      <div class="row">
        <label>Data stripes (k)<input type="number" min={STRIPE_LIMITS.k.min} max={STRIPE_LIMITS.k.max} data-testid="k" bind:value={s.k} /></label>
        <label>Parity stripes (m)<input type="number" min={STRIPE_LIMITS.m.min} max={STRIPE_LIMITS.m.max} data-testid="m" bind:value={s.m} /></label>
      </div>
      <label class="check">
        <input
          type="checkbox"
          data-testid="test-pattern"
          checked={s.source === 'test'}
          onchange={(e) => (s.source = (e.currentTarget as HTMLInputElement).checked ? 'test' : supportedSource('screen', can))}
        />
        Use a test pattern instead of capturing
      </label>
      <p class="hint">
        Viewers receive {s.k + s.m} stripes of ~{fmtKbps(Math.round(targetKbps(s.video, native) / s.k))}
        and need any {s.k} to decode. Parity stripes hide a relay leaving.
      </p>
    </details>

    <div class="dialog-actions">
      <button type="button" onclick={cancel}>Cancel</button>
      <button type="submit" class="primary" data-testid="start-share">{action}</button>
    </div>
  </form>
</dialog>
