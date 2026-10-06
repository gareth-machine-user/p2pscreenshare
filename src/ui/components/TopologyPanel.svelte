<script lang="ts">
  import type { TopologyReport } from '../../proto/messages'
  import { fmtKbps, fmtMs } from '../route'
  import TreeView from './TreeView.svelte'

  let { report, nameOf }: { report: TopologyReport | null; nameOf: (id: string) => string } = $props()

  const rows = $derived(
    report
      ? report.peers.map((p) => ({
          ...p,
          home: report.topology.home[p.id] ?? null,
          depth: report.depth[p.id] ?? [],
          slots: report.slots[p.id] ?? 0,
          late: Math.max(0, ...(p.stats?.stripes.map((s) => s.lateMs) ?? [0])),
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
  <TreeView
    topology={report.topology}
    hostId={report.publisher}
    stripes={report.k + report.m}
    names={new Map(rows.map((r) => [r.id, nameOf(r.id)]))}
  />
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Peer</th><th>Upload</th><th>Home</th><th>Slots</th><th>Children</th><th>Depth</th><th>Latency</th><th>FPS</th><th>Late</th></tr>
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
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
