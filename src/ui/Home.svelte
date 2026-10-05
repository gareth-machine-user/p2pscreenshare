<script lang="ts">
  let source = $state<'screen' | 'test'>('screen')
  let bitrate = $state(2500)
  let k = $state(4)
  let m = $state(1)
  let hostUpload = $state(10000)
  let audio = $state(true)
  let watchId = $state('')

  function share() {
    const q = new URLSearchParams({
      source,
      bitrate: String(bitrate),
      k: String(k),
      m: String(m),
      up: String(hostUpload),
      audio: audio ? '1' : '0',
      autostart: '1',
    })
    location.hash = `#/host?${q}`
  }

  function watch() {
    const id = watchId.trim().split('/watch/').pop()?.split('?')[0]
    if (id) location.hash = `#/watch/${encodeURIComponent(id)}`
  }
</script>

<div class="home">
  <section class="card">
    <h2>Share</h2>
    <label>
      Source
      <select bind:value={source}>
        <option value="screen">Screen / window / tab</option>
        <option value="test">Test pattern</option>
      </select>
    </label>
    <label>
      Video bitrate (kbps)
      <input type="number" min="300" max="20000" step="100" bind:value={bitrate} />
    </label>
    <div class="row">
      <label>
        Data stripes (k)
        <input type="number" min="1" max="16" bind:value={k} />
      </label>
      <label>
        Parity stripes (m)
        <input type="number" min="0" max="8" bind:value={m} />
      </label>
    </div>
    <label>
      Your upload budget (kbps)
      <input type="number" min="500" step="500" bind:value={hostUpload} />
    </label>
    <label class="check"><input type="checkbox" bind:checked={audio} /> Share audio (when available)</label>
    <p class="hint">
      Each viewer receives {k + m} stripes of ~{Math.round(bitrate / k)} kbps; any {k} suffice to decode. k=1, m=0 is a
      single relay tree.
    </p>
    <button class="primary" onclick={share}>Start sharing</button>
  </section>

  <section class="card">
    <h2>Watch</h2>
    <label>
      Stream link or id
      <input placeholder="e.g. 7kq2mz9xpa" bind:value={watchId} onkeydown={(e) => e.key === 'Enter' && watch()} />
    </label>
    <button class="primary" onclick={watch} disabled={!watchId.trim()}>Join</button>
  </section>
</div>
