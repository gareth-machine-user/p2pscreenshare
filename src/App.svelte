<script lang="ts">
  import { hostIdentity, newHostSeed } from './net/lobby'
  import { parseRoute } from './ui/route'
  import { rememberOwnerSeed } from './ui/settings.svelte'
  import Home from './ui/Home.svelte'
  import Lobby from './ui/Lobby.svelte'

  let route = $state(parseRoute(location.hash))
  let routeKey = $state(location.hash)

  $effect(() => {
    const onHash = () => {
      route = parseRoute(location.hash)
      routeKey = location.hash
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  })

  // Legacy owner link (`#/host?stream=<seed>`): keep the seed on this device and move to the lobby
  // page, so the address bar only ever shows the shareable join code.
  $effect(() => {
    if (route.page !== 'host') return
    const params = new URLSearchParams(route.params)
    const seed = params.get('stream') ?? newHostSeed()
    params.delete('stream')
    void hostIdentity(seed).then(({ joinCode }) => {
      rememberOwnerSeed(joinCode, seed)
      location.replace(`#/lobby/${joinCode}${params.size ? `?${params}` : ''}`)
    })
  })
</script>

{#key routeKey}
  {#if route.page === 'lobby'}
    <Lobby joinCode={route.joinCode} params={route.params} />
  {:else if route.page === 'home'}
    <header class="topbar">
      <a href="#/" class="brand">▣ p2pscreenshare</a>
      <span class="tagline">peer-to-peer screen sharing lobbies over WebRTC</span>
    </header>
    <main><Home /></main>
  {/if}
{/key}
