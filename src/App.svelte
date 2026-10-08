<script lang="ts">
  import { hostIdentity, newHostSeed } from './net/lobby'
  import { parseRoute } from './ui/route'
  import { rememberOwnerSeed } from './ui/settings.svelte'
  import { startErrorText } from './ui/lobbyView'
  import Home from './ui/Home.svelte'
  import Lobby from './ui/Lobby.svelte'

  let route = $state(parseRoute(location.hash))
  let routeKey = $state(location.hash)
  /** The legacy owner link couldn't be turned into a lobby (no WebCrypto, usually). */
  let redirectError = $state<string | null>(null)

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
    hostIdentity(seed).then(
      ({ joinCode }) => {
        rememberOwnerSeed(joinCode, seed)
        location.replace(`#/lobby/${joinCode}${params.size ? `?${params}` : ''}`)
      },
      (e) => {
        console.error('could not open the owner link', e)
        redirectError = startErrorText(e)
      },
    )
  })
</script>

{#key routeKey}
  {#if route.page === 'lobby'}
    <Lobby joinCode={route.joinCode} params={route.params} />
  {:else if route.page === 'home'}
    <Home />
  {:else if route.page === 'host' && redirectError}
    <p class="hint warn-text" role="alert" data-testid="redirect-error">{redirectError}</p>
  {/if}
{/key}
