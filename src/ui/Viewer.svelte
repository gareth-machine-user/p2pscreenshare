<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { ViewerSession } from '../session/viewerSession'
  import { fmtKbps, fmtMs, iceFrom, randomId, trackersFrom } from './route'

  let props: { streamId: string; params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const { streamId, params } = untrack(() => ({ ...props }))

  const capParam = params.get('up')
  const session = new ViewerSession(
    {
      streamId,
      name: params.get('name') ?? `viewer-${randomId(4)}`,
      trackers: trackersFrom(params),
      iceServers: iceFrom(params),
      capKbps: capParam ? Number(capParam) : null,
    },
    null,
  )
  window.__p2p = session

  let canvas: HTMLCanvasElement | undefined = $state()
  let tick = $state(0)
  let showStats = $state(true)
  let audioOn = $state(false)

  $effect(() => {
    session.player.setCanvas(canvas ?? null)
  })

  let pending = false
  session.onChange = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      tick++
    })
  }
  const refresh = setInterval(() => tick++, 500)
  onDestroy(() => {
    clearInterval(refresh)
    void session.leave()
  })

  const snap = $derived.by(() => {
    void tick
    const stats = session.stats
    const rtts = session.lastStats?.stripes.map((st) => st.rttMs) ?? []
    return {
      state: session.state,
      stats,
      rtts,
      player: session.player.stats,
      probeKbps: session.probeKbps,
      home: session.home,
      depth: session.depth,
      hostId: session.hostId,
      hasAudio: !!session.stream?.audio,
      trackers: session.trackersConnected,
    }
  })

  function enableAudio() {
    session.player.audio.enable()
    audioOn = true
  }

  function fullscreen() {
    void canvas?.requestFullscreen()
  }
</script>

<div class="viewer">
  <div class="stage">
    <canvas bind:this={canvas} data-testid="video"></canvas>
    {#if snap.state === 'joining'}
      <div class="overlay-msg">Looking for the host via trackers… ({snap.trackers} connected)</div>
    {:else if snap.state === 'host-lost'}
      <div class="overlay-msg">The host disconnected.</div>
    {:else if snap.player.decodedFrames === 0}
      <div class="overlay-msg">Connected — waiting for the first keyframe…</div>
    {/if}
    <div class="controls">
      {#if snap.hasAudio && !audioOn}<button onclick={enableAudio}>🔊 Enable audio</button>{/if}
      <button onclick={() => (showStats = !showStats)}>{showStats ? 'Hide' : 'Show'} stats</button>
      <button onclick={fullscreen}>Fullscreen</button>
    </div>
  </div>

  {#if showStats}
    <section class="card viewer-stats" data-testid="viewer-stats">
      <div class="stats-grid">
        <div><span>State</span><b data-testid="state">{snap.state}</b></div>
        <div><span>Glass-to-glass</span><b data-testid="latency">{fmtMs(snap.player.latencyMs)}</b></div>
        <div><span>Jitter buffer</span><b>{fmtMs(snap.player.bufferMs)}</b></div>
        <div><span>FPS</span><b>{snap.player.fps}</b></div>
        <div><span>Resolution</span><b>{snap.player.width}×{snap.player.height}</b></div>
        <div><span>Decoded / dropped</span><b>{snap.player.decodedFrames} / {snap.player.droppedFrames}</b></div>
        <div><span>Upload probe</span><b>{fmtKbps(snap.probeKbps)}{snap.stats.capKbps ? ` (cap ${fmtKbps(snap.stats.capKbps)})` : ''}</b></div>
        <div><span>Relaying</span><b>{snap.home === null ? 'no (leaf)' : `stripe ${snap.home} → ${snap.stats.children} children`}</b></div>
        <div><span>Uplink</span><b>{fmtKbps(snap.stats.uplinkKbps)}</b></div>
      </div>
      <table class="stripes">
        <thead><tr><th>Stripe</th><th>Parent</th><th>Depth</th><th>Last data</th><th>RTT</th></tr></thead>
        <tbody>
          {#each snap.stats.stripes as st, s}
            <tr class:stale={st.lastRecvAgoMs === null || st.lastRecvAgoMs > 1000}>
              <td>{s}</td>
              <td>{st.parent === snap.hostId ? 'host' : (st.parent?.slice(0, 6) ?? '—')}</td>
              <td>{snap.depth[s] ?? '—'}</td>
              <td>{st.lastRecvAgoMs === null ? 'never' : fmtMs(st.lastRecvAgoMs) + ' ago'}</td>
              <td>{fmtMs(snap.rtts[s])}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>
