<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { HostSession } from '../session/hostSession'
  import { newHostSeed } from '../net/lobby'
  import { fmtKbps, fmtMs, iceFrom, numParam, trackersFrom } from './route'
  import TreeView from './components/TreeView.svelte'

  let props: { params: URLSearchParams } = $props()
  // The page is remounted on every route change, so reading the initial props is intended.
  const params = untrack(() => props.params)

  // This page's `stream` param is the host's private seed: the viewer link's join code and the
  // key that signs the stream derive from it. Share the viewer link, never this page's URL.
  const streamId = params.get('stream') ?? newHostSeed()
  if (!params.get('stream')) {
    params.set('stream', streamId)
    history.replaceState(null, '', `#/host?${params}`)
  }

  const session = new HostSession({
    streamId,
    trackers: trackersFrom(params),
    iceServers: iceFrom(params),
    k: Math.max(1, numParam(params, 'k', 4)),
    m: Math.max(0, numParam(params, 'm', 1)),
    bitrateKbps: numParam(params, 'bitrate', 2500),
    hostUploadKbps: numParam(params, 'up', 10000),
    source: params.get('source') === 'test' ? 'test' : 'screen',
    audio: params.get('audio') !== '0',
    testSize: (params.get('res')?.split('x').map(Number) as [number, number] | undefined) ?? undefined,
  })
  window.__p2p = session

  let started = $state(false)
  let error = $state<string | null>(null)
  let tick = $state(0)
  let preview: HTMLVideoElement | undefined = $state()
  let hostUpload = $state(numParam(params, 'up', 10000))

  let pending = false
  session.onChange = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      tick++
    })
  }
  const refresh = setInterval(() => tick++, 1000)

  const base = `${location.origin}${location.pathname}${location.search}`
  // Carry tracker/ICE overrides into the viewer link.
  const shared = new URLSearchParams()
  for (const key of ['tracker', 'ice']) if (params.get(key)) shared.set(key, params.get(key)!)
  const watchUrl = $derived.by(() => {
    void tick
    return session.joinCode ? `${base}#/watch/${session.joinCode}${shared.size ? `?${shared}` : ''}` : ''
  })

  async function start() {
    error = null
    try {
      await session.start()
      started = true
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  if (params.get('autostart') === '1') void start()

  $effect(() => {
    if (preview && started && session.localStream) preview.srcObject = session.localStream
  })

  onDestroy(() => {
    clearInterval(refresh)
    void session.stop()
  })

  const snap = $derived.by(() => {
    void tick
    const peers = [...session.peers.values()].map((p) => ({
      p,
      home: session.topology.home[p.id] ?? null,
      depth: session.lastPlan?.depth[p.id] ?? [],
      slots: session.lastPlan?.slots[p.id] ?? 0,
      cap: session.capacityOf(p),
    }))
    peers.sort((a, b) => a.p.joinedAt - b.p.joinedAt)
    const lat = peers.map((x) => x.p.stats?.latencyMs).filter((x): x is number => x != null).sort((a, b) => a - b)
    return {
      peers,
      codec: session.codec,
      p50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
      p95: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : null,
      maxDepth: Math.max(0, ...peers.flatMap((x) => x.depth)),
      overcommitted: session.lastPlan?.overcommitted ?? 0,
      hostChildren: session.relay.allChildren().size,
      sentKbps: session.uplink.stats.sentBytes,
      topology: session.topology,
      changes: session.totalChanges,
    }
  })

  let lastSent = { at: performance.now(), bytes: 0 }
  let hostKbps = $state(0)
  const rate = setInterval(() => {
    const now = performance.now()
    const bytes = session.uplink.stats.sentBytes
    hostKbps = ((bytes - lastSent.bytes) * 8) / (now - lastSent.at)
    lastSent = { at: now, bytes }
  }, 1000)
  onDestroy(() => clearInterval(rate))

  function copy() {
    void navigator.clipboard.writeText(watchUrl)
  }
</script>

<div class="host">
  <section class="card share">
    <div>
      <div class="label">Viewer link</div>
      <div class="link-row">
        <code data-testid="watch-url">{watchUrl || 'Preparing link…'}</code>
        <button onclick={copy}>Copy</button>
      </div>
    </div>
    {#if !started}
      <button class="primary" onclick={start}>Start capture</button>
    {/if}
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  <div class="host-grid">
    <section class="card">
      <video bind:this={preview} autoplay muted playsinline class="preview"></video>
      <div class="stats-grid">
        <div><span>Viewers</span><b data-testid="viewer-count">{snap.peers.length}</b></div>
        <div><span>Codec</span><b>{snap.codec ?? '—'}</b></div>
        <div><span>Stripes</span><b>{session.config.k} + {session.config.m}</b></div>
        <div><span>Host upload</span><b>{fmtKbps(hostKbps)}</b></div>
        <div><span>Host children</span><b>{snap.hostChildren}</b></div>
        <div><span>Max depth</span><b>{snap.maxDepth}</b></div>
        <div><span>Latency p50 / p95</span><b>{fmtMs(snap.p50)} / {fmtMs(snap.p95)}</b></div>
        <div><span>Overcommitted</span><b>{snap.overcommitted}</b></div>
        <div><span>Parent changes</span><b>{snap.changes}</b></div>
      </div>
      <label class="inline">
        Upload budget (kbps)
        <input type="number" step="500" bind:value={hostUpload} onchange={() => session.setHostUpload(hostUpload)} />
      </label>
    </section>

    <section class="card">
      <h3>Relay trees</h3>
      <TreeView topology={snap.topology} hostId={session.selfId} stripes={session.stripes} names={new Map(snap.peers.map((x) => [x.p.id, x.p.name]))} />
    </section>
  </div>

  <section class="card">
    <h3>Peers</h3>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Peer</th><th>Capacity</th><th>Home</th><th>Slots</th><th>Children</th><th>Uplink</th><th>Depth</th>
            <th>Latency</th><th>Buffer</th><th>FPS</th><th>Dropped</th>
          </tr>
        </thead>
        <tbody>
          {#each snap.peers as x (x.p.id)}
            <tr>
              <td title={x.p.id}>{x.p.name}</td>
              <td>{fmtKbps(x.cap)}{x.p.stats?.capKbps ? ' (cap)' : ''}</td>
              <td>{x.home ?? '—'}</td>
              <td>{x.slots}</td>
              <td>{x.p.stats?.children ?? 0}</td>
              <td>{fmtKbps(x.p.stats?.uplinkKbps)}{x.p.stats && x.p.stats.uplinkDropRate > 0.01 ? ` ⚠ ${(x.p.stats.uplinkDropRate * 100).toFixed(0)}%` : ''}</td>
              <td>{x.depth.join(' ')}</td>
              <td>{fmtMs(x.p.stats?.latencyMs)}</td>
              <td>{fmtMs(x.p.stats?.bufferMs)}</td>
              <td>{x.p.stats?.fps ?? '—'}</td>
              <td>{x.p.stats?.droppedFrames ?? 0}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
</div>
