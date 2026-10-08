<script lang="ts" module>
  import type { EncoderRates, LossRates, SubscriberStats, TopologyReport, UplinkRates } from '../../proto/messages'
  import type { PlayerStats } from '../../media/player'
  import type { PeerSession } from '../../session/peerSession'
  import type { Subscription } from '../../session/subscription'
  import type { LivePeerRow } from '../liveRates'

  export type DetailsTab = 'stats' | 'peers' | 'topology'

  /** What the stage's details panel shows (built by the lobby each tick). */
  export interface DetailsView {
    presenting: boolean
    pub: { codec: string | null; subscribers: number; children: number; rootSlots: number; overcommitted: number; k: number; m: number } | null
    live: ReturnType<PeerSession['liveRates']>
    capacity: number | null
    encoderRates: EncoderRates | null
    uplinkRates: UplinkRates | null
    rate: ReturnType<PeerSession['rateStatus']>
    peers: LivePeerRow[]
    sub: Subscription | null
    source: ReturnType<PeerSession['stageView']>['source']
    playerStats: PlayerStats | null
    loss: LossRates | null
    stats: SubscriberStats | null
    report: TopologyReport | null
  }
</script>

<script lang="ts">
  import { fmtKbps, fmtMs } from '../route'
  import { fmtMbps } from '../liveRates'
  import { rateReason } from '../rateText'
  import PeersPanel from './PeersPanel.svelte'
  import TopologyPanel from './TopologyPanel.svelte'
  import FrameStats from './FrameStats.svelte'
  import PeerRates from './PeerRates.svelte'

  let {
    view,
    session,
    tab = $bindable(),
    tick,
    badges,
    nameOf,
    clamp,
    onkick,
  }: {
    view: DetailsView
    session: PeerSession | null
    tab: DetailsTab
    tick: number
    badges: (id: string) => string[]
    nameOf: (id: string) => string
    /** Why the bitrate is below the chosen quality, if it is. */
    clamp: string | null
    /** The owner may remove members. */
    onkick: ((id: string) => void) | null
  } = $props()
</script>

<div class="tabs">
  <button class:active={tab === 'stats'} onclick={() => (tab = 'stats')}>Stats</button>
  <button class:active={tab === 'peers'} data-testid="tab-peers" onclick={() => (tab = 'peers')}>Peers</button>
  <button class:active={tab === 'topology'} data-testid="tab-topology" onclick={() => (tab = 'topology')}>Topology</button>
</div>
{#if tab === 'peers' && session}
  <PeersPanel {session} {badges} {tick} {onkick} />
{:else if tab === 'topology'}
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
  <FrameStats encoder={view.encoderRates} uplink={view.uplinkRates} adapting={view.rate ? rateReason(view.rate) : null} stalledLanes={view.rate?.stalledLanes ?? 0} {clamp} />
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
