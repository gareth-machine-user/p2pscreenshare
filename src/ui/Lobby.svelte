<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { loadIdentity, ownerIdentity, ownerIdFromCode } from '../mesh/identity'
  import type { PublishPolicy } from '../mesh/auth'
  import { canCaptureScreen } from '../media/capture'
  import { DEFAULT_ICE } from '../net/bootstrap'
  import { PeerSession } from '../session/peerSession'
  import type { ShareOptions } from '../session/publishedStream'
  import { fmtKbps, fmtMs, iceFrom, lanesFrom, lobbyUrl, randomId, trackersFrom } from './route'
  import { applyAutoQuality, connectionWord, playbackReadout, resolveShareOptions, stageMessage, startErrorText } from './lobbyView'
  import { ownerSeed, saveSettings, settings } from './settings.svelte'
  import { maxSizeFor, targetKbps } from '../media/quality'
  import { nativeScreenSize } from './screen'
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
  import Logo from './components/Logo.svelte'
  import Avatar from './components/Avatar.svelte'
  import SidePanel from './components/SidePanel.svelte'
  import PeopleList, { type Person } from './components/PeopleList.svelte'
  import InviteCard from './components/InviteCard.svelte'
  import { dismissable } from './dismiss'

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
  /** Phones can't capture their screen: they share a camera. */
  const cameraOnly = !canCaptureScreen()
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
  /** The page couldn't start (no WebCrypto, or the session failed to start). */
  let initError = $state<string | null>(null)
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
  init().catch((e) => {
    console.error('lobby failed to start', e)
    if (!destroyed) initError = startErrorText(e)
  })

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
    return applyAutoQuality(resolveShareOptions(settings.share, params, urlOverrides, nativeScreenSize()), session)
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
    withName(session?.canShare ? `before you share your ${cameraOnly ? 'camera' : 'screen'}` : 'before you ask to share', () => {
      if (!session) return
      if (session.canShare) dialogOpen = true
      else session.requestPublish()
    })
  }

  /** Flips between the front and back cameras, keeping the stream. */
  async function flipCamera() {
    const pub = session?.publishing
    const facing = pub?.facing
    if (!pub || !facing) return
    const next = facing === 'user' ? 'environment' : 'user'
    try {
      await pub.switchCamera(next)
      settings.share.facing = next
      saveSettings()
    } catch (e) {
      shareError = e instanceof Error ? e.message : String(e)
    }
    onChange()
  }

  function sendChat(text: string): boolean {
    if (hasName) return session?.mesh.sendChat(text) ?? false
    // Keep the message and send it once a name is picked.
    withName('before you chat', () => void session?.mesh.sendChat(text))
    return true
  }

  /** Saves the (already bound) video quality and applies it to the running stream. */
  function applyQuality() {
    saveSettings()
    const v = settings.share.video
    if (session) session.autoBitrate = settings.share.autoLower
    // No new capture, no screen picker: the encoder is rebuilt in place.
    void session?.publishing?.setQuality(targetKbps(v, nativeScreenSize()), maxSizeFor(v.resolution), v.fps).then(onChange)
  }

  // --- view state --------------------------------------------------------------------------------

  let muted = $state(true)
  let copied = $state(false)
  let gearTab = $state<'stats' | 'peers' | 'topology'>('stats')
  /** The top bar's open popover. */
  let popover = $state<'invite' | 'settings' | null>(null)
  let settingsOpen = $derived(popover === 'settings')

  const closePopover = () => (popover = null)

  $effect(() => {
    void settings.view.chatOpen
    void settings.view.quality
    void settings.view.buffering
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

  /** Everyone in the lobby for the People tab: you first, then the owner, presenters and the rest. */
  const people = $derived.by((): Person[] => {
    void tick
    const s = session
    if (!s) return []
    const mesh = s.mesh
    const live = new Set(s.liveStreams().map((x) => x.publisher))
    const rank = (id: string) => (id === mesh.selfId ? 0 : id === ownerId ? 1 : live.has(id) ? 2 : 3)
    return [mesh.record, ...mesh.members()]
      .map((r) => {
        const self = r.id === mesh.selfId
        return {
          id: r.id,
          name: r.name || r.id.slice(0, 6),
          self,
          badges: badges(r.id),
          asking: s.requests.has(r.id),
          conn: self ? null : connectionWord(mesh.linkStatus(r.id), mesh.record.rtt[r.id] ?? r.rtt[mesh.selfId] ?? null),
        }
      })
      .sort((a, b) => rank(a.id) - rank(b.id))
  })

  // A phone that sleeps stops its camera: keep the screen on while sharing one.
  const sharingCamera = $derived(!!lobby?.sharing && !!session?.publishing?.facing)
  $effect(() => {
    if (!sharingCamera || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let done = false
    const acquire = () => {
      if (done || document.hidden) return
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (done) void l.release()
          else lock = l
        })
        .catch(() => {})
    }
    acquire()
    // The browser releases the lock when the page is hidden: take it again on return.
    document.addEventListener('visibilitychange', acquire)
    return () => {
      done = true
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
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
    // A test pattern or a camera can't film its own preview, so it always shows.
    const showOwnPreview = focused || s.publishing?.opts.source === 'test' || s.publishing?.opts.source === 'camera'
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
      cameraOnly,
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
      /** Who is on stage, when it's someone else. */
      onStage: stage && !presenting ? { id: stage.publisher, name: nameOf(stage.publisher) } : null,
      /** Nobody is sharing and this peer isn't either: the stage shows the invite card instead. */
      empty: !stage && !presenting && !shareError && (!!lobby?.joined || isOwner),
      ownPreviewShowing: presenting && showOwnPreview,
      readout: presenting ? null : playbackReadout(p),
      source: stageView.source,
      player: stageView.player,
      // The presenter sees what it shares while this tab is focused. Otherwise (it is probably in
      // the window it is sharing) a placeholder, so the capture doesn't film its own preview.
      localStream: presenting && showOwnPreview ? (s.publishing?.localStream ?? null) : null,
      mirror: presenting && s.publishing?.facing === 'user',
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

  // Playback buffering, for every stream watched.
  $effect(() => {
    const b = settings.view.buffering
    const s = session
    if (s && s.buffering !== b) untrack(() => s.setBuffering(b))
  })
</script>

{#snippet invite()}
  {#if lobby}
    <InviteCard
      {link}
      {isOwner}
      {cameraOnly}
      {copied}
      ownerAway={lobby.ownerAway}
      canShare={lobby.canShare}
      policy={lobby.policy}
      showShare={lobby.request !== 'waiting' && lobby.request !== 'owner-away' && (lobby.canShare || lobby.policy !== 'closed')}
      oncopy={copyLink}
      onshare={onShareClick}
      onpolicy={isOwner ? () => (popover = 'settings') : undefined}
    />
  {/if}
{/snippet}

<div class="lobby">
  <header class="lobby-bar">
    <a href="#/" class="home-link" title="Home" aria-label="Home"><Logo size={28} /></a>
    <span class="bar-divider"></span>
    <b class="lobby-name" data-testid="lobby-name">{lobby?.name ?? 'Lobby'}</b>
    {#if lobby}
      {@const faces = people.slice(0, 3)}
      <span class="presence" class:solo={faces.length < 2} title={lobby.joined ? 'People in this lobby' : `Looking for the lobby (${lobby.trackers} trackers connected)`}>
        {#if faces.length >= 2}
          <span class="avatar-stack">{#each faces as f (f.id)}<Avatar id={f.id} name={f.name} />{/each}</span>
        {:else}
          <span class="dot" class:off={!lobby.joined}></span>
        {/if}
        {#if lobby.joined || isOwner}<span><span data-testid="member-count">{lobby.members}</span> here</span>{:else}Connecting…{/if}
      </span>
    {/if}
    {#if lobby?.ownerAway && lobby.joined}<span class="badge warn" data-testid="owner-away">Owner away</span>{/if}
    <span class="spacer"></span>
    <div class="popover-anchor" use:dismissable={popover === 'invite' ? closePopover : null}>
      <button data-testid="invite" aria-expanded={popover === 'invite'} onclick={() => (popover = popover === 'invite' ? null : 'invite')}>
        <Icon name="link" />Invite
      </button>
      {#if popover === 'invite'}
        <div class="popover" data-testid="invite-panel">
          <p class="hint">Anyone with this link can join the lobby.</p>
          <div class="link-field">
            <label class="sr-only" for="lobby-link">Lobby link</label>
            <input id="lobby-link" data-testid="lobby-link" readonly value={link} onfocus={(e) => e.currentTarget.select()} />
            <button class="soft" data-testid="copy-link" onclick={copyLink}><Icon name={copied ? 'check' : 'copy'} />{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      {/if}
    </div>
    {#if lobby?.sharing}
      <!-- Stop is in the presenter bar under the stage. -->
    {:else if lobby?.request === 'waiting'}
      <span class="request-state"><span class="badge accent" data-testid="request-waiting">Waiting for the owner…</span><button onclick={() => session?.cancelRequest()}>Cancel</button></span>
    {:else if lobby?.request === 'owner-away'}
      <span class="request-state"><span class="badge warn" data-testid="request-owner-away">Owner is away</span><button onclick={() => session?.cancelRequest()}>Cancel</button></span>
    {:else if lobby}
      {#if lobby.request === 'denied'}<span class="badge warn" data-testid="request-denied">The owner declined</span>{/if}
      <button class={lobby.canShare ? 'primary' : 'soft'} data-testid="share-screen" onclick={onShareClick}>
        <Icon name={cameraOnly ? 'camera' : 'screen'} />{lobby.canShare ? (cameraOnly ? 'Share camera' : 'Share screen') : 'Ask to share'}
      </button>
    {/if}
    {#if isOwner && lobby}
      <div class="popover-anchor" use:dismissable={settingsOpen ? closePopover : null}>
        <button class="icon-only" data-testid="lobby-settings" aria-expanded={settingsOpen} aria-label="Lobby settings" title="Lobby settings" onclick={() => (popover = settingsOpen ? null : 'settings')}>
          <Icon name="sliders" size={17} />
        </button>
        {#if settingsOpen}
          <div class="popover" data-testid="lobby-settings-panel">
            <label>
              Who can share
              <select
                data-testid="policy"
                value={lobby.policy}
                onchange={(e) => void session?.setPolicy((e.currentTarget as HTMLSelectElement).value as PublishPolicy)}
              >
                <option value="ask">Ask me each time</option>
                <option value="open">Anyone</option>
                <option value="closed">Only me</option>
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
      {:else if initError}
        <Stage message={initError} />
      {:else if view}
          <Stage
            player={view.player}
            localStream={view.localStream}
            mirror={view.mirror}
            message={view.message}
            hasAudio={view.hasAudio}
            live={view.presenting}
            readout={view.readout}
            children={view.empty && lobby ? invite : undefined}
            qualityOptions={view.presenting || !view.sub ? null : ['auto', 'full', 'preview']}
            bind:quality={settings.view.quality}
            bind:buffering={settings.view.buffering}
            bind:muted
          >
            {#snippet chip()}
              {#if view.onStage}
                <span class="stage-chip" data-testid="presenter-chip">
                  <Avatar id={view.onStage.id} name={view.onStage.name} /><span><b>{view.onStage.name}</b> is presenting</span>
                </span>
              {:else if view.ownPreviewShowing && session?.publishing?.opts.source === 'screen'}
                <span class="stage-chip plain"><Icon name="eye" size={15} />Your preview. It hides when you leave this tab.</span>
              {/if}
            {/snippet}
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
                  <div><span>Relaying</span><b>{!view.sub?.homes.length ? 'no (leaf)' : `${view.sub.homes.length > 1 ? 'stripes' : 'stripe'} ${view.sub.homes.join(', ')} → ${view.stats?.children ?? 0} children`}</b></div>
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
        {#if lobby?.sharing && lobby.presenterAudio}
          <PresenterBar
            audio={lobby.presenterAudio}
            viewers={view.pub?.subscribers ?? null}
            limited={lobby.limited}
            clamp={lobby.clamp}
            uploading={lobby.uploading}
            uploadFraction={view.live.sendKbps !== null && view.capacity ? view.live.sendKbps / view.capacity : null}
            auto={session?.autoBitrate ?? false}
            bind:quality={settings.share.video}
            bind:autoLower={settings.share.autoLower}
            nativeSize={nativeScreenSize()}
            facing={session?.publishing?.facing ?? null}
            onflip={() => void flipCamera()}
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
            onquality={applyQuality}
            onstop={stopSharing}
          />
        {/if}
      {:else}
        <Stage message="Starting…" />
      {/if}
    </div>

    {#if session}
      {@const s = session}
      <SidePanel bind:open={settings.view.chatOpen} count={people.length} messages={lobby?.chat.length ?? 0}>
        {#snippet chat()}
          <ChatPanel
            messages={lobby?.chat ?? []}
            selfId={s.selfId}
            {badges}
            guestName={hasName ? null : name}
            onpickname={() => withName('to show in chat and the people list', () => {})}
            onsend={sendChat}
          />
        {/snippet}
        {#snippet roster()}
          <PeopleList
            {people}
            onkick={isOwner ? (id) => void s.kick(id) : null}
            onallow={isOwner ? (id) => void s.respond(id, 'allow') : null}
          />
        {/snippet}
      </SidePanel>
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
    title={switching ? 'Switch source' : cameraOnly ? 'Share your camera' : 'Share your screen'}
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

<!-- Leaving closes the session. If the browser keeps the page in its back/forward cache and Back
     restores it, that session is gone: reload to join again. -->
<svelte:window
  onpagehide={() => void session?.leave()}
  onpageshow={(e) => {
    if (e.persisted) location.reload()
  }}
/>
