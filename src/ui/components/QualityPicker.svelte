<script lang="ts">
  import {
    CUSTOM_KBPS,
    FPS_OPTIONS,
    fmtRate,
    LEVELS,
    RESOLUTIONS,
    targetKbps,
    type VideoQuality,
  } from '../../media/quality'

  let {
    quality = $bindable(),
    autoLower = $bindable(),
    nativeSize,
    onchange,
  }: {
    quality: VideoQuality
    autoLower: boolean
    /** The screen in device pixels (bitrate of the Native resolution). */
    nativeSize?: [number, number]
    /** Called after every change, e.g. to apply it to a live stream. */
    onchange?: () => void
  } = $props()

  // The custom bitrate slider is logarithmic: 0.5 to 150 Mbps in even steps of "feel".
  const LOG_MIN = Math.log(CUSTOM_KBPS.min)
  const LOG_MAX = Math.log(CUSTOM_KBPS.max)
  const toSlider = (kbps: number) => Math.round(((Math.log(kbps) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 1000)
  const fromSlider = (v: number) => {
    const kbps = Math.exp(LOG_MIN + (v / 1000) * (LOG_MAX - LOG_MIN))
    const step = kbps >= 10_000 ? 500 : kbps >= 2000 ? 100 : 50
    return Math.round(kbps / step) * step
  }

  const custom = $derived(quality.customKbps !== null)
  const kbps = $derived(targetKbps(quality, nativeSize))

  function set(patch: Partial<VideoQuality>) {
    quality = { ...quality, ...patch }
    onchange?.()
  }
</script>

<div class="quality-picker" data-testid="quality-picker">
  <div class="row">
    <label>
      Resolution
      <select data-testid="quality-resolution" value={quality.resolution} onchange={(e) => set({ resolution: e.currentTarget.value as VideoQuality['resolution'] })}>
        {#each RESOLUTIONS as r}<option value={r.value}>{r.label}</option>{/each}
      </select>
    </label>
    <label>
      Frame rate
      <select data-testid="quality-fps" value={String(quality.fps)} onchange={(e) => set({ fps: Number(e.currentTarget.value) as VideoQuality['fps'] })}>
        {#each FPS_OPTIONS as f}<option value={String(f)}>{f} fps</option>{/each}
      </select>
    </label>
  </div>

  <label>
    Quality
    <select
      data-testid="quality-level"
      value={custom ? 'custom' : quality.level}
      onchange={(e) => {
        const v = e.currentTarget.value
        if (v === 'custom') set({ customKbps: kbps })
        else set({ level: v as VideoQuality['level'], customKbps: null })
      }}
    >
      {#each LEVELS as l}
        <option value={l.value}>{l.label} ({fmtRate(targetKbps({ ...quality, level: l.value, customKbps: null }, nativeSize))})</option>
      {/each}
      <option value="custom">Custom bitrate…</option>
    </select>
  </label>

  {#if custom}
    <label class="custom">
      <span>Bitrate <b data-testid="quality-kbps">{fmtRate(kbps)}</b></span>
      <input
        type="range"
        data-testid="quality-custom"
        min="0"
        max="1000"
        value={toSlider(kbps)}
        oninput={(e) => {
          quality = { ...quality, customKbps: fromSlider(Number(e.currentTarget.value)) }
        }}
        onchange={() => onchange?.()}
      />
    </label>
  {/if}

  <label class="check" title="When viewers' connections can't carry the stream, lower the bitrate below your choice (never above it)">
    <input type="checkbox" data-testid="quality-auto-lower" checked={autoLower} onchange={(e) => {
      autoLower = e.currentTarget.checked
      onchange?.()
    }} />
    Lower automatically if viewers can't keep up
  </label>
  {#if kbps >= 30_000}
    <p class="hint" data-testid="quality-warning">
      {fmtRate(kbps)} needs a fast upload, and viewers' connections relay it too. Expect it to be
      lowered unless everyone is on fast connections.
    </p>
  {/if}
</div>

<style>
  .custom span {
    display: flex;
    justify-content: space-between;
  }
  .custom b {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .quality-picker .hint {
    margin: 0 0 12px;
  }
</style>
