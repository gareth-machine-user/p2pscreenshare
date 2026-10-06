<script lang="ts">
  import type { TopologyReport } from '../../proto/messages'
  import { fmtKbps, fmtMs } from '../route'
  import TreeView from './TreeView.svelte'
  import FrameStats from './FrameStats.svelte'

  let { report, nameOf }: { report: TopologyReport | null; nameOf: (id: string) => string } = $props()

  const rows = $derived(
    report
      ? report.peers.map((p) => ({
          ...p,
          home: report.topology.home[p.id] ?? null,
          depth: report.depth[p.id] ?? [],
          slots: report.slots[p.id] ?? 0,
          late: Math.max(0, ...(p.stats?.stripes.map((s) => s.lateMs) ?? [0])),
          lost: p.stats?.loss ? p.stats.loss.incomplete + p.stats.loss.late + p.stats.loss.undecodable + p.stats.loss.skipped : null,
          drops: p.stats?.uplinkRates ? p.stats.uplinkRates.drops : null,
          queueMs: p.stats?.uplinkRates?.queueMs ?? null,
        }))
      : [],
  )
</script>

{#if !report}
  <p class="hint" data-testid="topology-loading">Fetching the topology from the publisher…</p>
{:else}
  <div class="stats-grid" data-testid="topology-panel">
    <div><span>Stripes</span><b>{report.k} + {report.m}</b></div>
    <div><span>Subscribers</span><b>{report.peers.length}</b></div>
    <div><span>Publisher slots</span><b>{report.rootSlots}</b></div>
    <div><span>Max depth</span><b>{Math.max(0, ...rows.flatMap((r) => r.depth))}</b></div>
    <div><span>Overcommitted</span><b>{report.overcommitted}</b></div>
    <div><span>Parent changes</span><b>{report.changes}</b></div>
  </div>
  {#if report.publisherStats}
    <FrameStats encoder={report.publisherStats.encoder} uplink={report.publisherStats.uplink} />
    <h4>Viewers</h4>
  {/if}
  <TreeView
    topology={report.topology}
    hostId={report.publisher}
    stripes={report.k + report.m}
    names={new Map(rows.map((r) => [r.id, nameOf(r.id)]))}
  />
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Peer</th><th>Upload</th><th>Home</th><th>Slots</th><th>Children</th><th>Depth</th><th>Latency</th><th>FPS</th><th>Late</th>
          <th title="Frames in per second, and frames lost per second (incomplete, late, undecodable or skipped)">In / lost /s</th>
          <th title="Uplink fragments dropped per second for missing their deadline, by temporal layer">Drops T0/T1/T2</th>
          <th title="Average time fragments wait in this peer's uplink queue">Queue</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.id)}
          <tr>
            <td title={r.id}>{nameOf(r.id)}</td>
            <td>{fmtKbps(r.stats?.capacityKbps)}{r.stats && r.stats.uplinkDropRate > 0.01 ? ` ⚠ ${(r.stats.uplinkDropRate * 100).toFixed(0)}%` : ''}</td>
            <td>{r.home ?? '—'}</td>
            <td>{r.slots}</td>
            <td>{r.stats?.children ?? 0}</td>
            <td>{r.depth.join(' ')}</td>
            <td>{fmtMs(r.stats?.latencyMs)}</td>
            <td>{r.stats?.fps ?? '—'}</td>
            <td>{fmtMs(r.late)}</td>
            <td class:warn={(r.lost ?? 0) > 0.5}>{r.stats?.loss ? `${r.stats.loss.incomingFps} / ${Math.round((r.lost ?? 0) * 10) / 10}` : '—'}</td>
            <td class:warn={!!r.drops && r.drops[0] + r.drops[1] + r.drops[2] > 0.5}>{r.drops ? r.drops.join(' / ') : '—'}</td>
            <td>{fmtMs(r.queueMs)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
