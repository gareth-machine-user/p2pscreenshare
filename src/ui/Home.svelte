<script lang="ts">
  import { hostIdentity, newHostSeed } from '../net/lobby'
  import { joinCodeFrom } from './route'
  import { rememberOwnerSeed, saveSettings, settings } from './settings.svelte'

  let link = $state('')
  let creating = $state(false)
  const pasted = $derived(joinCodeFrom(link))

  async function create() {
    creating = true
    saveSettings()
    const seed = newHostSeed()
    const { joinCode } = await hostIdentity(seed)
    rememberOwnerSeed(joinCode, seed)
    location.hash = `#/lobby/${joinCode}`
  }

  function join() {
    if (!pasted) return
    saveSettings()
    location.hash = `#/lobby/${pasted}`
  }
</script>

<div class="home">
  <section class="card">
    <h2>Start a lobby</h2>
    <label>
      Your name
      <input
        data-testid="name"
        placeholder="How others see you"
        maxlength="32"
        bind:value={settings.name}
        onchange={saveSettings}
      />
    </label>
    <button class="primary" data-testid="create-lobby" onclick={create} disabled={creating}>Create lobby</button>
    <p class="hint">Everyone in a lobby can watch, and can share their screen once you allow it.</p>
    <div class="paste">
      <label>
        Have a link? Paste it
        <input
          data-testid="paste-link"
          placeholder="https://…#/lobby/…"
          bind:value={link}
          onkeydown={(e) => e.key === 'Enter' && join()}
        />
      </label>
      <button onclick={join} disabled={!pasted}>Join</button>
    </div>
  </section>
</div>
