<script lang="ts">
  import { hostIdentity, newHostSeed } from '../net/lobby'
  import { joinCodeFrom } from './route'
  import { rememberOwnerSeed, saveSettings, settings } from './settings.svelte'
  import Icon from './components/Icon.svelte'
  import Logo from './components/Logo.svelte'
  import RelayDiagram from './components/RelayDiagram.svelte'

  let link = $state('')
  let creating = $state(false)
  const pasted = $derived(joinCodeFrom(link))
  let nameInput: HTMLInputElement | undefined = $state()
  let how: HTMLElement | undefined = $state()

  async function create(e?: SubmitEvent) {
    e?.preventDefault()
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

  // The page is routed by the hash, so in-page links scroll instead of using `#id`.
  function showHow() {
    how?.scrollIntoView({ behavior: 'smooth' })
  }

  function backToStart() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
    nameInput?.focus({ preventScroll: true })
  }
</script>

<section class="home-hero">
  <div class="home-top">
    <a href="https://github.com/gareth-machine-user/p2pscreenshare" target="_blank" rel="noreferrer">Source</a>
  </div>

  <div class="home-center">
    <span class="brand"><Logo size={34} /><span><span class="p2p">p2p</span>screenshare</span></span>
    <div>
      <h1>Share your screen.</h1>
      <p class="lede">Start a lobby and send the link. Everyone watches right in their browser.</p>
    </div>

    <form class="home-form" onsubmit={create}>
      <label>
        Your name
        <input
          data-testid="name"
          placeholder="How others will see you"
          maxlength="32"
          autocomplete="nickname"
          bind:this={nameInput}
          bind:value={settings.name}
          onchange={saveSettings}
        />
      </label>
      <button type="submit" class="primary create" data-testid="create-lobby" disabled={creating}>
        Create a lobby<Icon name="arrowRight" size={18} />
      </button>
      <div class="divider">or join one</div>
      <div class="join">
        <label class="sr-only" for="paste-link">Lobby link</label>
        <input
          id="paste-link"
          data-testid="paste-link"
          placeholder="Paste a lobby link"
          bind:value={link}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              join()
            }
          }}
        />
        <button type="button" onclick={join} disabled={!pasted}>Join</button>
      </div>
    </form>
    <p class="home-note">No account, nothing to install.</p>
  </div>

  <button type="button" class="scroll-cue" onclick={showHow}>
    How it works<Icon name="chevronDown" size={18} />
  </button>
</section>

<section class="how" bind:this={how} aria-labelledby="how-title">
  <div class="how-inner">
    <div class="how-intro">
      <span class="eyebrow">How it works</span>
      <h2 id="how-title">Your screen goes straight to the people watching.</h2>
      <p>No media server sits in the middle. Browsers connect to each other directly, and public trackers are only used to help them find the lobby.</p>
    </div>

    <ol class="steps">
      <li>
        <span class="step-num">1</span>
        <h3>Create a lobby</h3>
        <p>You own it. Up to about 50 people can be in one lobby.</p>
      </li>
      <li>
        <span class="step-num">2</span>
        <h3>Send the link</h3>
        <p>Anyone with it joins instantly, no sign-up. They can chat and ask to share.</p>
      </li>
      <li>
        <span class="step-num">3</span>
        <h3>Share your screen</h3>
        <p>A screen, a window, a tab, or your camera on a phone, with sound.</p>
      </li>
    </ol>

    <div class="relay-panel">
      <div>
        <h3>Viewers pass it on</h3>
        <p>
          Instead of sending a copy to every viewer, you send the stream once, cut into stripes. Viewers with good
          connections relay each stripe to a few others, so your upload doesn't grow with the audience.
        </p>
        <p>Each viewer needs only some of the stripes to play, so someone leaving mid-stream doesn't freeze anyone's picture.</p>
        <div class="legend">
          <span><i style:background="#6aa8ff"></i>Stripe 1</span>
          <span><i style:background="#b49cff"></i>Stripe 2</span>
          <span><i class="relay"></i>Viewer that relays</span>
        </div>
      </div>
      <RelayDiagram />
    </div>

    <div class="facts">
      <div>
        <span class="fact-icon"><Icon name="zap" size={18} /></span>
        <div>
          <h3>Low delay</h3>
          <p>Relays forward each piece the moment it arrives, and each viewer's buffer adapts to their own connection.</p>
        </div>
      </div>
      <div>
        <span class="fact-icon"><Icon name="volume" size={18} /></span>
        <div>
          <h3>Sound that holds up</h3>
          <p>192 kbps audio, spread across stripes like the video, so music and voices stay clean.</p>
        </div>
      </div>
      <div>
        <span class="fact-icon"><Icon name="shield" size={18} /></span>
        <div>
          <h3>You choose who presents</h3>
          <p>Approve each request to share, open the floor to everyone, or keep it to yourself.</p>
        </div>
      </div>
    </div>

    <div class="cta">
      <h2>Ready when you are.</h2>
      <button type="button" class="primary create" onclick={backToStart}>Create a lobby<Icon name="arrowUp" size={18} /></button>
    </div>
  </div>
</section>

<footer class="home-footer">
  <span>Open source</span>
  <span>Video and audio go straight between browsers</span>
</footer>
