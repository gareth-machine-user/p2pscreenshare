<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { loadIdentity, ownerIdentity, ownerIdFromCode } from '../mesh/identity'
  import type { PublishPolicy } from '../mesh/auth'
  import { DEFAULT_ICE } from '../net/bootstrap'
  import { PeerSession } from '../session/peerSession'
  import type { ShareOptions } from '../session/publishedStream'
  import { fmtKbps, fmtMs, iceFrom, lanesFrom, lobbyUrl, randomId, trackersFrom } from './route'
  import { applyAutoQuality, resolveShareOptions, stageMessage } from './lobbyView'
  import { ownerSeed, QUALITY_PRESETS, saveSettings, settings, type QualityPreset } from './settings.svelte'
  import Stage from './components/Stage.svelte'
  import ShareDialog from './components/ShareDialog.svelte'
  import ChatPanel from './components/ChatPanel.svelte'
  import PeersPanel from './components/PeersPanel.svelte'
  import TopologyPanel from './components/TopologyPanel.svelte'
  import TileRail, { type Tile } from './components/TileRail.svelte'
  import RequestToasts from './components/RequestToasts.svelte'
  import PresenterBar from './components/PresenterBar.svelte'
  import NameDialog from './components/NameDialog.svelte'
  import FrameStats from './components/FrameStats.svelte'
  import { rateReason, rateText } from './rateText'
  import { fmtMbps, sessionPeers, uploadBadge } from './liveRates'
  import PeerRates from './components/PeerRates.svelte'
  import Icon from './components/Icon.svelte'

  let props: { joinCode: string; params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const { joinCode, params } = untrack(() => ({ ...props }))

  const seed = ownerSeed(joinCode)
  const isOwner = seed !== null
  const chosenName = (params.get('name') ?? settings.name).trim()
  const name = chosenName || `guest-${randomId(4)}`
  /** Guests join anonymously, but must pick a name before sharing or chatting. */
  let hasName = $state(chosenName.length > 0)
  /** What to do once the name dialog is answered. */
  let pendingNamed = $state<{ reason: string; then: () => void } | null>(null)

  /** Runs `action` now if this peer has a name, or after it picks one. */
  function withName(reason: string, action: () => void): void {
    if (hasName) action()
    else pendingNamed = { reason, then: action }
  }

  function saveName(newName: string) {
    settings.name = newName
    saveSettings()
    hasName = true
    session?.mesh.updateRecord({ name: newName })
    const next = pendingNamed?.then
    pendingNamed = null
    next?.()
  }
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
      lanes: lanesFrom(params),
    })
    s.onChange = onChange
    s.quality = settings.view.quality
    // The owner granted our request: go straight to the share dialog (or share, in tests).
    s.onGranted = () => {
      if (urlOverrides) void startSharing()
      else dialogOpen = true
    }
    window.__p2p = s
    window.__mesh = s.mesh
    session = s
    await s.start()
    if (destroyed) return void s.leave()
    if (urlOverrides) {
      if (s.canShare) void startSharing()
      else waitForLobbyThenRequest(s)
    }
  }
  void init()

  /** Tests: ask to share once linked to the owner. */
  function waitForLobbyThenRequest(s: PeerSession) {
    const t = setInterval(() => {
      if (destroyed) return clearInterval(t)
      if (s.mesh.linkFor(s.ownerId) && s.mesh.member(s.ownerId)) {
        clearInterval(t)
        s.requestPublish()
      }
    }, 200)
  }

  onDestroy(() => {
    destroyed = true
    clearInterval(refresh)
    void session?.leave()
  })

  // --- sharing -----------------------------------------------------------------------------------

  let shareError = $state<string | null>(null)
  let dialogOpen = $state(false)
  let switching = $state(false)

  /** The options to share with: the settings (or URL overrides), with auto quality applied to the session. */
  function shareOptions(): ShareOptions {
    return applyAutoQuality(resolveShareOptions(settings.share, params, urlOverrides), session)
  }

  /** Starts (or restarts, with the current settings: a brief blip) this peer's stream. */
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

  function onShareClick() {
    withName(session?.canShare ? 'before you share your screen' : 'before you ask to share', () => {
      if (!session) return
      if (session.canShare) dialogOpen = true
      else session.requestPublish()
    })
  }

  function sendChat(text: string): boolean {
    if (hasName) return session?.mesh.sendChat(text) ?? false
    // Keep the message and send it once a name is picked.
    withName('before you chat', () => void session?.mesh.sendChat(text))
    return true
  }

  function changeQuality(q: QualityPreset) {
    settings.share.quality = q
    saveSettings()
    const preset = QUALITY_PRESETS[q]
    if (session) session.autoBitrate = q === 'auto'
    // Applied to the running stream: no new capture, no screen picker.
    void session?.publishing?.setQuality(preset.kbps, [preset.maxWidth, preset.maxHeight]).then(onChange)
  }

  // --- view state --------------------------------------------------------------------------------

  let muted = $state(true)
  let copied = $state(false)
  let gearTab = $state<'stats' | 'peers' | 'topology'>('stats')
  let settingsOpen = $state(false)

  $effect(() => {
    void settings.view.chatOpen
    void settings.view.quality
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
    const rate = session.rateStatus()
    const rateLine = rate ? rateText(rate) : null
    return {
      name: owner?.name ? `${owner.name}'s lobby` : isOwner ? 'Your lobby' : 'Lobby',
      members: mesh.memberCount,
      ownerAway: !owner,
      joined: mesh.joined,
      trackers: mesh.trackersConnected,
      chat: mesh.chat,
      canShare: session.canShare,
      sharing: !!session.publishing,
      request: session.requestState,
      // Names resolved here, each tick: a requester's renamed record can arrive after its request.
      requests: [...session.requests.values()].map((r) => ({ id: r.id, name: nameOf(r.id) })),
      policy: session.policy,
      revoked: session.revokedNotice,
      presenterAudio: session.publishing?.audio ?? null,
      limited: session.publishing?.full?.limited ?? null,
      clamp: rateLine,
      kicked: session.kicked,
      uploading: session.publishing
        ? uploadBadge({
            sendKbps: session.liveRates().sendKbps,
            capacityKbps: session.capacity.uplinkKbps,
            rate: rateLine,
            local: session.localLoad,
          })
        : null,
    }
  })

  /** Whether this tab has focus (the presenter's own preview only shows then, like Discord). */
  let focused = $state(document.hasFocus() && !document.hidden)
  $effect(() => {
    const update = () => (focused = document.hasFocus() && !document.hidden)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  })

  const view = $derived.by(() => {
    void tick
    const s = session
    if (!s) return null
    // A test pattern can't film itself, so it always shows.
    const showOwnPreview = focused || s.publishing?.opts.source === 'test'
    const stageView = s.stageView()
    const presenting = stageView.source === 'local'
    const sub = s.stageSub
    const p = stageView.player?.stats ?? null
    const streams = s.liveStreams()
    const stage = streams.find((x) => x.publisher === s.selected) ?? null
    const message = stageMessage({
      joined: !!lobby?.joined,
      trackers: lobby?.trackers ?? 0,
      presenting,
      showOwnPreview,
      stage: stage ? { name: nameOf(stage.publisher), decoding: !!p && p.decodedFrames > 0 } : null,
      shareError,
      canShare: s.canShare,
      ownerAway: !!lobby?.ownerAway,
    })
    const pub = s.publishing?.full ?? null
    const tiles: Tile[] =
      streams.length >= 2
        ? streams.map((x) => ({
            publisher: x.publisher,
            name: x.publisher === s.selfId ? `${nameOf(x.publisher)} (you)` : nameOf(x.publisher),
            player: s.subFor(x.publisher, 'preview')?.player ?? null,
            localStream: x.publisher === s.selfId && showOwnPreview ? (s.publishing?.localStream ?? null) : null,
            hasAudio: !!x.ann.stream?.audio,
            selected: x.publisher === s.selected,
            canStop: s.isOwner && x.publisher !== s.selfId,
          }))
        : []
    return {
      presenting,
      source: stageView.source,
      player: stageView.player,
      // The presenter sees what it shares while this tab is focused. Otherwise (it is probably in
      // the window it is sharing) a placeholder, so the capture doesn't film its own preview.
      localStream: presenting && showOwnPreview ? (s.publishing?.localStream ?? null) : null,
      message,
      sub,
      stats: sub?.lastStats ?? null,
      playerStats: p,
      hasAudio: !!sub?.ann.stream?.audio,
      capacity: s.capacity.uplinkKbps,
      live: s.liveRates(),
      peers: gearTab === 'stats' ? sessionPeers(s) : [],
      loss: sub?.loss ?? null,
      uplinkRates: s.uplinkStatsNow,
      encoderRates: s.encoderStatsNow,
      rate: s.rateStatus(),
      channel: presenting ? (pub?.id ?? null) : (sub?.channel ?? null),
      tiles,
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
  // Primitives, so the effect below re-runs only when they change (`view` is a new object every tick,
  // and re-subscribing would make the publisher send a full report each time).
  const topoChannel = $derived(view?.channel ?? null)
  const topoPresenting = $derived(view?.presenting ?? false)
  $effect(() => {
    const s = session
    const ch = topoChannel
    if (!s || ch === null || gearTab !== 'topology' || topoPresenting) return
    untrack(() => s.watchTopology(ch, true))
    return () => s.watchTopology(ch, false)
  })

  // The main player's quality choice.
  $effect(() => {
    const q = settings.view.quality
    const s = session
    if (s && s.quality !== q) untrack(() => s.setQuality(q))
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
    {#if lobby?.sharing}
      <button data-testid="stop-share" onclick={stopSharing}><Icon name="stop" />Stop sharing</button>
    {:else if lobby?.request === 'waiting'}
      <span class="badge" data-testid="request-waiting">Waiting for the owner…</span>
      <button onclick={() => session?.cancelRequest()}>Cancel</button>
    {:else if lobby?.request === 'owner-away'}
      <span class="badge warn" data-testid="request-owner-away">Owner is away</span>
      <button onclick={() => session?.cancelRequest()}>Cancel</button>
    {:else if lobby}
      {#if lobby.request === 'denied'}<span class="badge warn" data-testid="request-denied">The owner declined</span>{/if}
      <button class="primary" data-testid="share-screen" onclick={onShareClick}>
        <Icon name="screen" />{lobby.canShare ? 'Share screen' : 'Ask to share'}
      </button>
    {/if}
    {#if isOwner && lobby}
      <div class="popover-anchor">
        <button data-testid="lobby-settings" aria-expanded={settingsOpen} onclick={() => (settingsOpen = !settingsOpen)} title="Lobby settings">
          <Icon name="gear" />
        </button>
        {#if settingsOpen}
          <div class="popover" data-testid="lobby-settings-panel">
            <label>
              Who may share
              <select
                data-testid="policy"
                value={lobby.policy}
                onchange={(e) => void session?.setPolicy((e.currentTarget as HTMLSelectElement).value as PublishPolicy)}
              >
                <option value="ask">Ask me each time</option>
                <option value="open">Anyone (Allow all)</option>
                <option value="closed">Only me (Deny all)</option>
              </select>
            </label>
          </div>
        {/if}
      </div>
    {/if}
  </header>

  {#if lobby?.revoked}
    <div class="banner" data-testid="revoked">The owner stopped your stream.</div>
  {/if}
  {#if lobby?.kicked}
    <div class="banner" data-testid="kicked">The owner removed you from the lobby.</div>
  {/if}

  <div class="lobby-body">
    <div class="stage-col">
      {#if invalid}
        <Stage message="This link is incomplete. Ask for the full lobby link." />
      {:else if view}
        <div class="main-row">
          <Stage
            player={view.player}
            localStream={view.localStream}
            message={view.message}
            hasAudio={view.hasAudio}
            qualityOptions={view.presenting || !view.sub ? null : ['auto', 'full', 'preview']}
            bind:quality={settings.view.quality}
            bind:muted
          >
            {#snippet panel()}
              <div class="tabs">
                <button class:active={gearTab === 'stats'} onclick={() => (gearTab = 'stats')}>Stats</button>
                <button class:active={gearTab === 'peers'} data-testid="tab-peers" onclick={() => (gearTab = 'peers')}>Peers</button>
                <button class:active={gearTab === 'topology'} data-testid="tab-topology" onclick={() => (gearTab = 'topology')}>Topology</button>
              </div>
              {#if gearTab === 'peers' && session}
                <PeersPanel {session} {badges} {tick} onkick={isOwner ? (id) => void session?.kick(id) : null} />
              {:else if gearTab === 'topology'}
                <TopologyPanel report={view.report} {nameOf} joinedAt={(id) => session?.mesh.member(id)?.joinedAt} />
              {:else if view.presenting && view.pub}
                <div class="stats-grid" data-testid="publisher-stats">
                  <div><span>Viewers</span><b data-testid="viewer-count">{view.pub.subscribers}</b></div>
                  <div><span>Codec</span><b>{view.pub.codec ?? '—'}</b></div>
                  <div><span>Stripes</span><b>{view.pub.k} + {view.pub.m}</b></div>
                  <div><span>Uploading now</span><b data-testid="live-send-total" title="Live, all connections, last 2 s">{fmtMbps(view.live.sendKbps)}</b></div>
                  <div><span>Upload capacity</span><b data-testid="upload-capacity" title="What your uplink carried when it was full (or in the last headroom probe); not current use">{fmtKbps(view.capacity)}</b></div>
                  <div><span>Your slots / children</span><b>{view.pub.rootSlots} / {view.pub.children}</b></div>
                  <div><span>Overcommitted</span><b>{view.pub.overcommitted}</b></div>
                </div>
                <FrameStats encoder={view.encoderRates} uplink={view.uplinkRates} adapting={view.rate ? rateReason(view.rate) : null} stalledLanes={view.rate?.stalledLanes ?? 0} clamp={lobby?.clamp ?? null} />
                <PeerRates rows={view.peers} />
              {:else}
                <div class="stats-grid" data-testid="viewer-stats">
                  <div><span>State</span><b data-testid="state">{view.sub ? 'connected' : 'idle'}</b></div>
                  <div><span>Showing</span><b data-testid="stage-source">{view.source}</b></div>
                  <div><span>Glass-to-glass</span><b data-testid="latency">{fmtMs(view.playerStats?.latencyMs)}</b></div>
                  <div><span>Jitter buffer</span><b>{fmtMs(view.playerStats?.bufferMs)}</b></div>
                  <div><span>FPS</span><b>{view.playerStats?.fps ?? '—'}</b></div>
                  <div><span>Resolution</span><b>{view.playerStats?.width ?? 0}×{view.playerStats?.height ?? 0}</b></div>
                  <div><span>Decoded / dropped</span><b>{view.playerStats?.decodedFrames ?? 0} / {view.playerStats?.droppedFrames ?? 0}</b></div>
                  <div><span>Receiving now</span><b data-testid="live-recv-total" title="Live, all connections, last 2 s">{fmtMbps(view.live.recvKbps)}</b></div>
                  <div><span>Uploading now</span><b title="Live, all connections, last 2 s (relaying and probes)">{fmtMbps(view.live.sendKbps)}</b></div>
                  <div><span>Upload capacity</span><b title="What your uplink carried when it was full (or in the last headroom probe); not current use">{fmtKbps(view.capacity)}</b></div>
                  <div><span>Relaying</span><b>{view.sub?.home == null ? 'no (leaf)' : `stripe ${view.sub.home} → ${view.stats?.children ?? 0} children`}</b></div>
                </div>
                <FrameStats loss={view.loss} renderedFps={view.playerStats?.fps ?? null} uplink={view.uplinkRates} />
                <PeerRates rows={view.peers} />
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
          {#if view.tiles.length}
            <TileRail
              tiles={view.tiles}
              onselect={(p) => {
                session?.select(p)
                onChange()
              }}
              onstop={(p) => void session?.revokePublisher(p)}
            />
          {/if}
        </div>
        {#if lobby?.sharing && lobby.presenterAudio}
          <PresenterBar
            audio={lobby.presenterAudio}
            limited={lobby.limited}
            clamp={lobby.clamp}
            uploading={lobby.uploading}
            auto={session?.autoBitrate ?? false}
            quality={settings.share.quality}
            onmic={(m) => {
              session?.publishing?.setMicMuted(m)
              onChange()
            }}
            onsystem={(m) => {
              session?.publishing?.setSystemMuted(m)
              onChange()
            }}
            onswitch={() => {
              switching = true
              dialogOpen = true
            }}
            onquality={changeQuality}
            onstop={stopSharing}
          />
        {/if}
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
        onsend={sendChat}
      />
    {/if}
  </div>
</div>

{#if pendingNamed}
  <NameDialog reason={pendingNamed.reason} onsave={saveName} oncancel={() => (pendingNamed = null)} />
{/if}

{#if lobby?.requests.length}
  <RequestToasts requests={lobby.requests} onrespond={(id, a) => void session?.respond(id, a)} />
{/if}

{#if dialogOpen}
  <ShareDialog
    micSupported
    title={switching ? 'Switch source' : 'Share your screen'}
    action={switching ? 'Switch' : 'Share'}
    onstart={() => {
      dialogOpen = false
      switching = false
      void startSharing()
    }}
    oncancel={() => {
      dialogOpen = false
      switching = false
      session?.cancelRequest()
    }}
  />
{/if}

<svelte:window onpagehide={() => void session?.leave()} />
