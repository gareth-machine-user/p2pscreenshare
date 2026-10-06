<script lang="ts">
  import { fmtKbps } from '../route'
  import {
    clampStripes,
    DEFAULT_SETTINGS,
    QUALITY_PRESETS,
    saveSettings,
    settings,
    STRIPE_LIMITS,
    type SourceKind,
  } from '../settings.svelte'

  let {
    onstart,
    oncancel,
    /** Whether the mic option is offered. */
    micSupported = false,
    title = 'Share your screen',
    action = 'Share',
  }: { onstart: () => void; oncancel: () => void; micSupported?: boolean; title?: string; action?: string } = $props()

  const s = settings.share
  let advanced = $state(s.source === 'test' || s.k !== DEFAULT_SETTINGS.share.k || s.m !== DEFAULT_SETTINGS.share.m)
  let dialog: HTMLDialogElement | undefined = $state()

  $effect(() => {
    dialog?.showModal()
  })

  const SOURCES: { value: Exclude<SourceKind, 'test'>; label: string }[] = [
    { value: 'screen', label: 'Entire screen' },
    { value: 'window', label: 'Window' },
    { value: 'tab', label: 'Browser tab' },
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
    {#if s.source !== 'test'}
      <fieldset class="segmented">
        <legend>Source</legend>
        {#each SOURCES as src}
          <label class:active={s.source === src.value}>
            <input type="radio" name="source" value={src.value} bind:group={s.source} />{src.label}
          </label>
        {/each}
      </fieldset>
    {/if}
    <label class="check">
      <input type="checkbox" data-testid="system-audio" bind:checked={s.systemAudio} /> Share system/tab audio
    </label>
    {#if micSupported}
      <label class="check"><input type="checkbox" data-testid="mic" bind:checked={s.mic} /> Include microphone</label>
    {/if}
    <label>
      Quality
      <select data-testid="quality-preset" bind:value={s.quality}>
        {#each Object.entries(QUALITY_PRESETS) as [value, p]}
          <option {value}>{p.label}{value === 'auto' ? '' : ` (${fmtKbps(p.kbps)})`}</option>
        {/each}
      </select>
    </label>

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
          onchange={(e) => (s.source = (e.currentTarget as HTMLInputElement).checked ? 'test' : 'screen')}
        />
        Use a test pattern instead of capturing
      </label>
      <p class="hint">
        Viewers receive {s.k + s.m} stripes of ~{Math.round(QUALITY_PRESETS[s.quality].kbps / s.k)} kbps
        and need any {s.k} to decode. Parity stripes hide a relay leaving.
      </p>
    </details>

    <div class="dialog-actions">
      <button type="button" onclick={cancel}>Cancel</button>
      <button type="submit" class="primary" data-testid="start-share">{action}</button>
    </div>
  </form>
</dialog>
