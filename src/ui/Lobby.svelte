<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { loadIdentity, ownerIdentity, ownerIdFromCode } from '../mesh/identity'
  import { DEFAULT_ICE } from '../net/bootstrap'
  import { PeerSession } from '../session/peerSession'
  import type { ShareOptions } from '../session/publisher'
  import { fmtKbps, fmtMs, iceFrom, lobbyUrl, numParam, randomId, trackersFrom } from './route'
  import { ownerSeed, QUALITY_PRESETS, saveSettings, settings } from './settings.svelte'
  import Stage from './components/Stage.svelte'
  import ShareDialog from './components/ShareDialog.svelte'
  import ChatPanel from './components/ChatPanel.svelte'
  import PeersPanel from './components/PeersPanel.svelte'
  import TopologyPanel from './components/TopologyPanel.svelte'
  import Icon from './components/Icon.svelte'

  let props: { joinCode: string; params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const { joinCode, params } = untrack(() => ({ ...props }))

  const seed = ownerSeed(joinCode)
  const isOwner = seed !== null
  const name = params.get('name') ?? (settings.name || `guest-${randomId(4)}`)
  const link = lobbyUrl(joinCode, params)
  const iceServers = iceFrom(params) ?? DEFAULT_ICE
  /** Test/debug overrides from the URL (`share=1&source=test&k=…`); not persisted. */
  const urlOverrides = params.get('share') === '1'

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

  let session = $state<PeerSession | null>(null)
  let invalid = $state(false)
  let ownerId: string | null = null
  let destroyed = false

  async function init(): Promise<void> {
    ownerId = await ownerIdFromCode(joinCode)
    if (!ownerId) {
      invalid = true
      return
    }
    const identity = seed ? await ownerIdentity(seed) : await loadIdentity(joinCode)
    if (destroyed) return
    const capParam = params.get('up')
    const s = new PeerSession({
      joinCode,
      identity,
      ownerId,
      name,
      trackers: trackersFrom(params),
      iceServers,
      capKbps: capParam ? Number(capParam) : null,
      block: params.get('block')?.split(',').filter(Boolean),
    })
    s.onChange = onChange
    window.__p2p = s
    window.__mesh = s.mesh
    session = s
    await s.start()
    if (destroyed) return void s.leave()
    if (urlOverrides && s.canShare) void startSharing()
  }
  void init()

  onDestroy(() => {
    destroyed = true
    clearInterval(refresh)
    void session?.leave()
  })

  // --- sharing -----------------------------------------------------------------------------------

  let shareError = $state<string | null>(null)
  let dialogOpen = $state(false)

  function shareOptions(): ShareOptions {
    const sh = settings.share
    const preset = QUALITY_PRESETS[sh.quality]
    const test = sh.source === 'test' || (urlOverrides && params.get('source') === 'test')
    return {
      k: Math.max(1, urlOverrides ? numParam(params, 'k', sh.k) : sh.k),
      m: Math.max(0, urlOverrides ? numParam(params, 'm', sh.m) : sh.m),
      bitrateKbps: urlOverrides ? numParam(params, 'bitrate', preset.kbps) : preset.kbps,
      source: test ? 'test' : 'screen',
      surface: sh.source === 'window' ? 'window' : sh.source === 'tab' ? 'browser' : 'monitor',
      maxSize: [preset.maxWidth, preset.maxHeight],
      audio: sh.systemAudio && params.get('audio') !== '0',
      testSize: (params.get('res')?.split('x').map(Number) as [number, number] | undefined) ?? undefined,
    }
  }

  /** Starts (or restarts, with the current settings) this peer's stream. */
  async function startSharing(): Promise<void> {
    if (!session) return
    shareError = null
    try {
      await session.share(shareOptions())
    } catch (e) {
      shareError = e instanceof Error ? e.message : String(e)
    }
    onChange()
  }

  function stopSharing() {
    session?.stopSharing()
    onChange()
  }

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

  function nameOf(id: string): string {
    return session?.mesh.member(id)?.name || id.slice(0, 6)
  }

  function badges(id: string): string[] {
    const out: string[] = []
    if (id === ownerId) out.push('owner')
    if (session?.liveStreams().some((s) => s.publisher === id)) out.push('presenting')
    return out
  }

  const lobby = $derived.by(() => {
    void tick
    if (!session) return null
    const mesh = session.mesh
    const owner = mesh.member(mesh.ownerId)
    return {
      name: owner?.name ? `${owner.name}'s lobby` : isOwner ? 'Your lobby' : 'Lobby',
      members: mesh.memberCount,
      ownerAway: !owner,
      joined: mesh.joined,
      trackers: mesh.trackersConnected,
      chat: mesh.chat,
      canShare: session.canShare,
      sharing: !!session.publishing,
    }
  })

  const view = $derived.by(() => {
    void tick
    const s = session
    if (!s) return null
    const presenting = !!s.publishing && s.selected === s.selfId
    const sub = s.stageSub
    const p = sub?.player.stats ?? null
    const stage = s.liveStreams().find((x) => x.publisher === s.selected) ?? null
    const message = !lobby?.joined
      ? `Looking for the lobby… (${lobby?.trackers ?? 0} trackers connected)`
      : presenting
        ? null
        : !stage
          ? shareError
            ? `Couldn't start sharing: ${shareError}`
            : s.canShare
              ? 'Click Share screen to present to the lobby.'
              : lobby?.ownerAway
                ? 'The owner is away. Nobody is sharing.'
                : 'Nobody is sharing yet.'
          : !p || p.decodedFrames === 0
            ? `Connecting to ${nameOf(stage.publisher)}'s stream…`
            : null
    const pub = s.publishing?.full ?? null
    return {
      presenting,
      localStream: presenting ? (s.publishing?.localStream ?? null) : null,
      message,
      sub,
      player: p,
      stats: sub?.lastStats ?? null,
      hasAudio: !!sub?.ann.stream?.audio,
      capacity: s.capacity.estimateKbps,
      channel: presenting ? (pub?.id ?? null) : (sub?.channel ?? null),
      pub: pub
        ? {
            codec: s.codec,
            subscribers: [...pub.subscribers.values()].filter((x) => x.active).length,
            children: s.relay.allChildren(pub.id).size,
            rootSlots: s.rootSlots(pub.id),
            overcommitted: pub.lastPlan?.overcommitted ?? 0,
            k: pub.k,
            m: pub.m,
          }
        : null,
      report: presenting && pub ? pub.report() : sub ? (s.topologyReports.get(sub.channel) ?? null) : null,
    }
  })

  // Topology reports are fetched from the publisher only while the panel is open.
  $effect(() => {
    const s = session
    const ch = view?.channel ?? null
    if (!s || ch === null || gearTab !== 'topology' || view?.presenting) return
    untrack(() => s.watchTopology(ch, true))
    return () => s.watchTopology(ch, false)
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
    {#if lobby?.canShare}
      {#if lobby.sharing}
        <button data-testid="stop-share" onclick={stopSharing}><Icon name="stop" />Stop sharing</button>
      {:else}
        <button class="primary" data-testid="share-screen" onclick={() => (dialogOpen = true)}><Icon name="screen" />Share screen</button>
      {/if}
    {/if}
  </header>

  <div class="lobby-body">
    <div class="stage-col">
      {#if invalid}
        <Stage message="This link is incomplete. Ask for the full lobby link." />
      {:else if view}
        <Stage
          player={view.presenting ? null : (view.sub?.player ?? null)}
          localStream={view.localStream}
          message={view.message}
          hasAudio={view.hasAudio}
          bind:muted
        >
          {#snippet panel()}
            <div class="tabs">
              <button class:active={gearTab === 'stats'} onclick={() => (gearTab = 'stats')}>Stats</button>
              <button class:active={gearTab === 'peers'} data-testid="tab-peers" onclick={() => (gearTab = 'peers')}>Peers</button>
              <button class:active={gearTab === 'topology'} data-testid="tab-topology" onclick={() => (gearTab = 'topology')}>Topology</button>
            </div>
            {#if gearTab === 'peers' && session}
              <PeersPanel mesh={session.mesh} {badges} {tick} />
            {:else if gearTab === 'topology'}
              <TopologyPanel report={view.report} {nameOf} />
            {:else if view.presenting && view.pub}
              <div class="stats-grid" data-testid="publisher-stats">
                <div><span>Viewers</span><b data-testid="viewer-count">{view.pub.subscribers}</b></div>
                <div><span>Codec</span><b>{view.pub.codec ?? '—'}</b></div>
                <div><span>Stripes</span><b>{view.pub.k} + {view.pub.m}</b></div>
                <div><span>Your upload</span><b>{fmtKbps(view.capacity)}</b></div>
                <div><span>Your slots / children</span><b>{view.pub.rootSlots} / {view.pub.children}</b></div>
                <div><span>Overcommitted</span><b>{view.pub.overcommitted}</b></div>
              </div>
            {:else}
              <div class="stats-grid" data-testid="viewer-stats">
                <div><span>State</span><b data-testid="state">{view.sub ? 'connected' : 'idle'}</b></div>
                <div><span>Glass-to-glass</span><b data-testid="latency">{fmtMs(view.player?.latencyMs)}</b></div>
                <div><span>Jitter buffer</span><b>{fmtMs(view.player?.bufferMs)}</b></div>
                <div><span>FPS</span><b>{view.player?.fps ?? '—'}</b></div>
                <div><span>Resolution</span><b>{view.player?.width ?? 0}×{view.player?.height ?? 0}</b></div>
                <div><span>Decoded / dropped</span><b>{view.player?.decodedFrames ?? 0} / {view.player?.droppedFrames ?? 0}</b></div>
                <div><span>Your upload</span><b>{fmtKbps(view.capacity)}</b></div>
                <div><span>Relaying</span><b>{view.sub?.home == null ? 'no (leaf)' : `stripe ${view.sub.home} → ${view.stats?.children ?? 0} children`}</b></div>
                <div><span>Uplink</span><b>{fmtKbps(view.stats?.uplinkKbps)}</b></div>
              </div>
              {#if view.stats}
                <table class="stripes">
                  <thead><tr><th>Stripe</th><th>Parent</th><th>Depth</th><th>Last data</th><th>RTT</th><th>Late</th></tr></thead>
                  <tbody>
                    {#each view.stats.stripes as st, i}
                      <tr class:stale={st.lastRecvAgoMs === null || st.lastRecvAgoMs > 1000}>
                        <td>{i}</td>
                        <td>{st.parent === view.sub?.publisher ? 'publisher' : st.parent ? nameOf(st.parent) : '—'}</td>
                        <td>{view.sub?.depth[i] ?? '—'}</td>
                        <td>{st.lastRecvAgoMs === null ? 'never' : fmtMs(st.lastRecvAgoMs) + ' ago'}</td>
                        <td>{fmtMs(st.rttMs)}</td>
                        <td>{fmtMs(st.lateMs)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            {/if}
          {/snippet}
        </Stage>
      {:else}
        <Stage message="Starting…" />
      {/if}
    </div>

    {#if session}
      <ChatPanel
        messages={lobby?.chat ?? []}
        selfId={session.selfId}
        {badges}
        bind:open={settings.view.chatOpen}
        onsend={(text) => session?.mesh.sendChat(text) ?? false}
      />
    {/if}
  </div>
</div>

{#if dialogOpen}
  <ShareDialog
    onstart={() => {
      dialogOpen = false
      void startSharing()
    }}
    oncancel={() => (dialogOpen = false)}
  />
{/if}

<svelte:window onpagehide={() => void session?.leave()} />
