<script lang="ts">
  import { parseRoute } from './ui/route'
  import Home from './ui/Home.svelte'
  import Host from './ui/Host.svelte'
  import Viewer from './ui/Viewer.svelte'

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
</script>

<header class="topbar">
  <a href="#/" class="brand">▣ p2pscreenshare</a>
  <span class="tagline">striped peer-to-peer relay trees over WebRTC</span>
</header>

<main>
  {#key routeKey}
    {#if route.page === 'host'}
      <Host params={route.params} />
    {:else if route.page === 'watch'}
      <Viewer streamId={route.streamId} params={route.params} />
    {:else}
      <Home />
    {/if}
  {/key}
</main>
