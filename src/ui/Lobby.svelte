<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { HostSession, type HostOptions } from '../session/hostSession'
  import { ViewerSession } from '../session/viewerSession'
  import { fmtKbps, fmtMs, iceFrom, lobbyUrl, numParam, randomId, trackersFrom } from './route'
  import { ownerSeed, QUALITY_PRESETS, settings } from './settings.svelte'
  import Stage from './components/Stage.svelte'
  import ShareDialog from './components/ShareDialog.svelte'
  import TreeView from './components/TreeView.svelte'
  import Icon from './components/Icon.svelte'

  let props: { joinCode: string; params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const { joinCode, params } = untrack(() => ({ ...props }))

  const seed = ownerSeed(joinCode)
  const isOwner = seed !== null
  const name = params.get('name') ?? (settings.name || `guest-${randomId(4)}`)
  const link = lobbyUrl(joinCode, params)

  let tick = $state(0)
  let pending = false
  const onChange = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      tick++
    })
  }
  const refresh = setInterval(() => tick++, 500)

  // --- owner: today's host session, restarted whenever sharing starts, stops or changes ---------

  let host = $state<HostSession | null>(null)
  let sharing = $state(false)
  let shareError = $state<string | null>(null)
  let dialogOpen = $state(false)
  /** Test/debug overrides from the URL (`share=1&source=test&k=…`); not persisted. */
  const urlOverrides = params.get('share') === '1'

  function hostOptions(): HostOptions {
    const sh = settings.share
    const preset = QUALITY_PRESETS[sh.quality]
    const test = sh.source === 'test' || (urlOverrides && params.get('source') === 'test')
    return {
      streamId: seed!,
      trackers: trackersFrom(params),
      iceServers: iceFrom(params),
      k: Math.max(1, urlOverrides ? numParam(params, 'k', sh.k) : sh.k),
      m: Math.max(0, urlOverrides ? numParam(params, 'm', sh.m) : sh.m),
      bitrateKbps: urlOverrides ? numParam(params, 'bitrate', preset.kbps) : preset.kbps,
      hostUploadKbps: numParam(params, 'up', 10000),
      source: test ? 'test' : 'screen',
      surface: sh.source === 'window' ? 'window' : sh.source === 'tab' ? 'browser' : 'monitor',
      maxSize: [preset.maxWidth, preset.maxHeight],
      audio: sh.systemAudio && params.get('audio') !== '0',
      testSize: (params.get('res')?.split('x').map(Number) as [number, number] | undefined) ?? undefined,
    }
  }

  async function restartHost(capture: boolean): Promise<void> {
    const old = host
    host = null
    await old?.stop()
    const s = new HostSession(hostOptions())
    s.onChange = onChange
    window.__p2p = s
    host = s
    sharing = false
    if (!capture) return
    shareError = null
    try {
      await s.start()
      sharing = true
    } catch (e) {
      shareError = e instanceof Error ? e.message : String(e)
      await restartHost(false)
    }
  }

  // --- member: today's viewer session ------------------------------------------------------------

  const capParam = params.get('up')
  const viewer: ViewerSession | null = isOwner
    ? null
    : new ViewerSession(
        { streamId: joinCode, name, trackers: trackersFrom(params), iceServers: iceFrom(params), capKbps: capParam ? Number(capParam) : null },
        null,
      )
  if (viewer) {
    viewer.onChange = onChange
    window.__p2p = viewer
  } else {
    void restartHost(urlOverrides)
  }

  onDestroy(() => {
    clearInterval(refresh)
    void host?.stop()
    void viewer?.leave()
  })

  // --- view state --------------------------------------------------------------------------------

  let muted = $state(true)
  let copied = $state(false)

  function copyLink() {
    void navigator.clipboard?.writeText(link).catch(() => {})
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  const view = $derived.by(() => {
    void tick
    if (host) {
      const peers = [...host.peers.values()].map((p) => ({
        p,
        home: host!.topology.home[p.id] ?? null,
        depth: host!.lastPlan?.depth[p.id] ?? [],
        slots: host!.lastPlan?.slots[p.id] ?? 0,
        cap: host!.capacityOf(p),
      }))
      peers.sort((a, b) => a.p.joinedAt - b.p.joinedAt)
      const lat = peers.map((x) => x.p.stats?.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b)
      return {
        kind: 'host' as const,
        members: peers.length + 1,
        peers,
        codec: host.codec,
        p50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
        maxDepth: Math.max(0, ...peers.flatMap((x) => x.depth)),
        overcommitted: host.lastPlan?.overcommitted ?? 0,
        hostChildren: host.relay.allChildren().size,
        changes: host.totalChanges,
        topology: host.topology,
      }
    }
    if (viewer) {
      const st = viewer.state
      const p = viewer.player.stats
      const message =
        st === 'joining'
          ? `Looking for the lobby… (${viewer.trackersConnected} trackers connected)`
          : st === 'invalid-link'
            ? 'This link is incomplete. Ask for the full lobby link.'
            : st === 'host-lost'
              ? 'Reconnecting to the lobby…'
              : !viewer.stream
                ? 'Nobody is sharing yet.'
                : p.decodedFrames === 0
                  ? 'Connected. Waiting for the first keyframe…'
                  : null
      return {
        kind: 'viewer' as const,
        members: null,
        state: st,
        message,
        player: p,
        stats: viewer.stats,
        rtts: viewer.lastStats?.stripes.map((s) => s.rttMs) ?? [],
        home: viewer.home,
        depth: viewer.depth,
        hostId: viewer.hostId,
        hasAudio: !!viewer.stream?.audio,
        probeKbps: viewer.probeKbps,
      }
    }
    return null
  })
</script>

<div class="lobby">
  <header class="lobby-bar">
    <a href="#/" class="brand" title="Home">▣ p2pscreenshare</a>
    <b class="lobby-name" data-testid="lobby-name">{isOwner ? 'Your lobby' : 'Lobby'}</b>
    <button data-testid="copy-link" onclick={copyLink}><Icon name="link" />{copied ? 'Copied' : 'Copy link'}</button>
    <code class="lobby-link" data-testid="lobby-link">{link}</code>
    <span class="spacer"></span>
    {#if view?.members}<span class="members" data-testid="member-count" title="Members"><Icon name="users" /> {view.members}</span>{/if}
    {#if isOwner}
      {#if sharing}
        <button data-testid="stop-share" onclick={() => restartHost(false)}>Stop sharing</button>
      {:else}
        <button class="primary" data-testid="share-screen" onclick={() => (dialogOpen = true)}><Icon name="screen" />Share screen</button>
      {/if}
    {/if}
  </header>

  <div class="lobby-body">
    <div class="stage-col">
      {#if view?.kind === 'host'}
        <Stage
          localStream={sharing ? (host?.localStream ?? null) : null}
          message={sharing ? null : shareError ? `Couldn't start sharing: ${shareError}` : 'Click Share screen to present to the lobby.'}
        >
          {#snippet panel()}
            <div class="stats-grid">
              <div><span>Viewers</span><b data-testid="viewer-count">{view.peers.length}</b></div>
              <div><span>Codec</span><b>{view.codec ?? '—'}</b></div>
              <div><span>Stripes</span><b>{host?.config.k} + {host?.config.m}</b></div>
              <div><span>Your children</span><b>{view.hostChildren}</b></div>
              <div><span>Max depth</span><b>{view.maxDepth}</b></div>
              <div><span>Latency p50</span><b>{fmtMs(view.p50)}</b></div>
              <div><span>Overcommitted</span><b>{view.overcommitted}</b></div>
              <div><span>Parent changes</span><b>{view.changes}</b></div>
            </div>
            <h4>Topology</h4>
            <TreeView
              topology={view.topology}
              hostId={host?.selfId ?? ''}
              stripes={host?.stripes ?? 1}
              names={new Map(view.peers.map((x) => [x.p.id, x.p.name]))}
            />
            <h4>Peers</h4>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Peer</th><th>Capacity</th><th>Home</th><th>Slots</th><th>Children</th><th>Depth</th><th>Latency</th><th>FPS</th></tr>
                </thead>
                <tbody>
                  {#each view.peers as x (x.p.id)}
                    <tr>
                      <td title={x.p.id}>{x.p.name}</td>
                      <td>{fmtKbps(x.cap)}</td>
                      <td>{x.home ?? '—'}</td>
                      <td>{x.slots}</td>
                      <td>{x.p.stats?.children ?? 0}</td>
                      <td>{x.depth.join(' ')}</td>
                      <td>{fmtMs(x.p.stats?.latencyMs)}</td>
                      <td>{x.p.stats?.fps ?? '—'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/snippet}
        </Stage>
      {:else if view?.kind === 'viewer'}
        <Stage player={viewer?.player ?? null} message={view.message} hasAudio={view.hasAudio} bind:muted>
          {#snippet panel()}
            <div class="stats-grid" data-testid="viewer-stats">
              <div><span>State</span><b data-testid="state">{view.state}</b></div>
              <div><span>Glass-to-glass</span><b data-testid="latency">{fmtMs(view.player.latencyMs)}</b></div>
              <div><span>Jitter buffer</span><b>{fmtMs(view.player.bufferMs)}</b></div>
              <div><span>FPS</span><b>{view.player.fps}</b></div>
              <div><span>Resolution</span><b>{view.player.width}×{view.player.height}</b></div>
              <div><span>Decoded / dropped</span><b>{view.player.decodedFrames} / {view.player.droppedFrames}</b></div>
              <div><span>Upload probe</span><b>{fmtKbps(view.probeKbps)}</b></div>
              <div><span>Relaying</span><b>{view.home === null ? 'no (leaf)' : `stripe ${view.home} → ${view.stats.children} children`}</b></div>
              <div><span>Uplink</span><b>{fmtKbps(view.stats.uplinkKbps)}</b></div>
            </div>
            <table class="stripes">
              <thead><tr><th>Stripe</th><th>Parent</th><th>Depth</th><th>Last data</th><th>RTT</th></tr></thead>
              <tbody>
                {#each view.stats.stripes as st, s}
                  <tr class:stale={st.lastRecvAgoMs === null || st.lastRecvAgoMs > 1000}>
                    <td>{s}</td>
                    <td>{st.parent === view.hostId ? 'publisher' : (st.parent?.slice(0, 6) ?? '—')}</td>
                    <td>{view.depth[s] ?? '—'}</td>
                    <td>{st.lastRecvAgoMs === null ? 'never' : fmtMs(st.lastRecvAgoMs) + ' ago'}</td>
                    <td>{fmtMs(view.rtts[s])}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </Stage>
      {:else}
        <Stage message="Starting…" />
      {/if}
    </div>
  </div>
</div>

{#if dialogOpen}
  <ShareDialog
    onstart={() => {
      dialogOpen = false
      void restartHost(true)
    }}
    oncancel={() => (dialogOpen = false)}
  />
{/if}
