<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Mesh } from '../mesh/mesh'
  import { loadIdentity, ownerIdentity, ownerIdFromCode, type PeerIdentity } from '../mesh/identity'
  import { DEFAULT_ICE } from '../net/bootstrap'
  import { meshControl } from '../session/control'
  import { HostSession, type HostOptions } from '../session/hostSession'
  import { ViewerSession } from '../session/viewerSession'
  import type { HostToViewer, ViewerToHost } from '../proto/messages'
  import { fmtKbps, fmtMs, iceFrom, lobbyUrl, numParam, randomId, trackersFrom } from './route'
  import { ownerSeed, QUALITY_PRESETS, saveSettings, settings } from './settings.svelte'
  import Stage from './components/Stage.svelte'
  import ShareDialog from './components/ShareDialog.svelte'
  import TreeView from './components/TreeView.svelte'
  import ChatPanel from './components/ChatPanel.svelte'
  import PeersPanel from './components/PeersPanel.svelte'
  import Icon from './components/Icon.svelte'

  let props: { joinCode: string; params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const { joinCode, params } = untrack(() => ({ ...props }))

  const seed = ownerSeed(joinCode)
  const isOwner = seed !== null
  const name = params.get('name') ?? (settings.name || `guest-${randomId(4)}`)
  const link = lobbyUrl(joinCode, params)
  const iceServers = iceFrom(params) ?? DEFAULT_ICE

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

  let mesh = $state<Mesh | null>(null)
  let invalid = $state(false)
  let identity: PeerIdentity | null = null
  let ownerId: string | null = null
  let destroyed = false

  // --- owner: today's host session on the mesh, restarted whenever sharing starts, stops or changes

  let host = $state<HostSession | null>(null)
  let sharing = $state(false)
  let shareError = $state<string | null>(null)
  let dialogOpen = $state(false)
  /** Test/debug overrides from the URL (`share=1&source=test&k=…`); not persisted. */
  const urlOverrides = params.get('share') === '1'

  function hostOptions(m: Mesh): HostOptions {
    const sh = settings.share
    const preset = QUALITY_PRESETS[sh.quality]
    const test = sh.source === 'test' || (urlOverrides && params.get('source') === 'test')
    return {
      ctl: meshControl<ViewerToHost, HostToViewer>(m),
      signingKey: identity!.privateKey,
      iceServers,
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
    sharing = false
    await old?.stop()
    if (!mesh || destroyed) return
    const s = new HostSession(hostOptions(mesh))
    s.onChange = onChange
    window.__p2p = s
    host = s
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

  // --- member: today's viewer session on the mesh -------------------------------------------------

  let viewer = $state<ViewerSession | null>(null)

  async function init(): Promise<void> {
    ownerId = await ownerIdFromCode(joinCode)
    if (!ownerId) {
      invalid = true
      return
    }
    identity = seed ? await ownerIdentity(seed) : await loadIdentity(joinCode)
    if (destroyed) return
    const m = new Mesh({
      joinCode,
      identity,
      ownerId,
      name,
      trackers: trackersFrom(params),
      iceServers,
      block: params.get('block')?.split(',').filter(Boolean),
    })
    m.onChange = onChange
    window.__mesh = m
    mesh = m
    await m.start()
    if (destroyed) return void m.leave()
    if (isOwner) {
      await restartHost(urlOverrides)
    } else {
      const capParam = params.get('up')
      const v = new ViewerSession(
        { streamId: joinCode, name, ctl: meshControl(m), ownerId, iceServers, capKbps: capParam ? Number(capParam) : null },
        null,
      )
      v.onChange = onChange
      window.__p2p = v
      viewer = v
    }
  }
  void init()

  onDestroy(() => {
    destroyed = true
    clearInterval(refresh)
    void host?.stop()
    void viewer?.leave()
    void mesh?.leave()
  })

  // --- view state --------------------------------------------------------------------------------

  let muted = $state(true)
  let copied = $state(false)
  let gearTab = $state<'stats' | 'peers' | 'topology'>('stats')

  $effect(() => {
    void settings.view.chatOpen
    saveSettings()
  })

  function copyLink() {
    void navigator.clipboard?.writeText(link).catch(() => {})
    copied = true
    setTimeout(() => (copied = false), 1500)
  }

  function badges(id: string): string[] {
    const out: string[] = []
    if (id === ownerId) out.push('owner')
    if (id === ownerId && ((host && sharing) || viewer?.stream)) out.push('presenting')
    return out
  }

  const lobby = $derived.by(() => {
    void tick
    if (!mesh) return null
    const owner = mesh.member(mesh.ownerId)
    return {
      name: owner?.name ? `${owner.name}'s lobby` : isOwner ? 'Your lobby' : 'Lobby',
      members: mesh.memberCount,
      ownerAway: !owner,
      joined: mesh.joined,
      trackers: mesh.trackersConnected,
      chat: mesh.chat,
    }
  })

  const view = $derived.by(() => {
    void tick
    if (host) {
      const peers = [...host.peers.values()].map((p) => ({
        p,
        name: mesh?.member(p.id)?.name || p.id.slice(0, 6),
        home: host!.topology.home[p.id] ?? null,
        depth: host!.lastPlan?.depth[p.id] ?? [],
        slots: host!.lastPlan?.slots[p.id] ?? 0,
        cap: host!.capacityOf(p),
      }))
      peers.sort((a, b) => a.p.joinedAt - b.p.joinedAt)
      const lat = peers.map((x) => x.p.stats?.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b)
      return {
        kind: 'host' as const,
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
      const message = !lobby?.joined
        ? `Looking for the lobby… (${lobby?.trackers ?? 0} trackers connected)`
        : st === 'invalid-link'
          ? 'This link is incomplete. Ask for the full lobby link.'
          : !viewer.stream
            ? lobby?.ownerAway
              ? 'The owner is away. Nobody is sharing.'
              : 'Nobody is sharing yet.'
            : p.decodedFrames === 0
              ? 'Connected. Waiting for the first keyframe…'
              : null
      return {
        kind: 'viewer' as const,
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
    <b class="lobby-name" data-testid="lobby-name">{lobby?.name ?? 'Lobby'}</b>
    {#if lobby?.ownerAway && lobby.joined}<span class="badge warn" data-testid="owner-away">Owner away</span>{/if}
    <button data-testid="copy-link" onclick={copyLink}><Icon name="link" />{copied ? 'Copied' : 'Copy link'}</button>
    <code class="lobby-link" data-testid="lobby-link">{link}</code>
    <span class="spacer"></span>
    {#if lobby}<span class="members" data-testid="member-count" title="Members"><Icon name="users" /> {lobby.members}</span>{/if}
    {#if isOwner}
      {#if sharing}
        <button data-testid="stop-share" onclick={() => restartHost(false)}><Icon name="stop" />Stop sharing</button>
      {:else}
        <button class="primary" data-testid="share-screen" disabled={!host} onclick={() => (dialogOpen = true)}><Icon name="screen" />Share screen</button>
      {/if}
    {/if}
  </header>

  <div class="lobby-body">
    <div class="stage-col">
      {#if invalid}
        <Stage message="This link is incomplete. Ask for the full lobby link." />
      {:else if view?.kind === 'host'}
        <Stage
          localStream={sharing ? (host?.localStream ?? null) : null}
          message={sharing ? null : shareError ? `Couldn't start sharing: ${shareError}` : 'Click Share screen to present to the lobby.'}
        >
          {#snippet panel()}
            <div class="tabs">
              <button class:active={gearTab === 'stats'} onclick={() => (gearTab = 'stats')}>Stats</button>
              <button class:active={gearTab === 'peers'} data-testid="tab-peers" onclick={() => (gearTab = 'peers')}>Peers</button>
              <button class:active={gearTab === 'topology'} onclick={() => (gearTab = 'topology')}>Topology</button>
            </div>
            {#if gearTab === 'stats'}
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
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Peer</th><th>Capacity</th><th>Home</th><th>Slots</th><th>Children</th><th>Depth</th><th>Latency</th><th>FPS</th></tr>
                  </thead>
                  <tbody>
                    {#each view.peers as x (x.p.id)}
                      <tr>
                        <td title={x.p.id}>{x.name}</td>
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
            {:else if gearTab === 'peers' && mesh}
              <PeersPanel {mesh} {badges} {tick} />
            {:else}
              <TreeView
                topology={view.topology}
                hostId={host?.selfId ?? ''}
                stripes={host?.stripes ?? 1}
                names={new Map(view.peers.map((x) => [x.p.id, x.name]))}
              />
            {/if}
          {/snippet}
        </Stage>
      {:else if view?.kind === 'viewer'}
        <Stage player={viewer?.player ?? null} message={view.message} hasAudio={view.hasAudio} bind:muted>
          {#snippet panel()}
            <div class="tabs">
              <button class:active={gearTab === 'stats'} onclick={() => (gearTab = 'stats')}>Stats</button>
              <button class:active={gearTab === 'peers'} data-testid="tab-peers" onclick={() => (gearTab = 'peers')}>Peers</button>
            </div>
            {#if gearTab === 'peers' && mesh}
              <PeersPanel {mesh} {badges} {tick} />
            {:else}
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
            {/if}
          {/snippet}
        </Stage>
      {:else}
        <Stage message={lobby && !lobby.joined ? `Looking for the lobby… (${lobby.trackers} trackers connected)` : 'Starting…'} />
      {/if}
    </div>

    {#if mesh}
      <ChatPanel
        messages={lobby?.chat ?? []}
        selfId={mesh.selfId}
        {badges}
        bind:open={settings.view.chatOpen}
        onsend={(text) => mesh?.sendChat(text) ?? false}
      />
    {/if}
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

<svelte:window onpagehide={() => void mesh?.leave()} />
