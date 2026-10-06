<script lang="ts">
  import type { Mesh } from '../../mesh/mesh'
  import { fmtKbps, fmtMs } from '../route'

  let { mesh, badges, tick }: { mesh: Mesh; badges: (id: string) => string[]; tick: number } = $props()

  // Everything here comes from gossip records, so the panel costs no extra traffic.
  const rows = $derived.by(() => {
    void tick
    const all = [mesh.record, ...mesh.members()].sort((a, b) => a.joinedAt - b.joinedAt)
    const n = all.length
    return all.map((r) => {
      const self = r.id === mesh.selfId
      const unreachable = new Set([...r.unreachable, ...all.filter((o) => o.unreachable.includes(r.id)).map((o) => o.id)])
      return {
        id: r.id,
        name: r.name || r.id.slice(0, 6),
        self,
        status: self ? 'you' : mesh.linkStatus(r.id),
        rtt: self ? null : (mesh.record.rtt[r.id] ?? r.rtt[mesh.selfId] ?? null),
        capacity: r.capacityKbps,
        unreachable: unreachable.size,
        // Can't reach a good part of the lobby: it only gets the stripes it can reach.
        limited: n > 2 && unreachable.size >= Math.max(1, Math.floor((n - 1) / 3)),
      }
    })
  })
</script>

<div class="table-wrap" data-testid="peers-panel">
  <table>
    <thead><tr><th>Peer</th><th>Link</th><th>RTT</th><th>Upload</th><th>Unreachable</th></tr></thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr data-testid="peer-row" data-peer={r.id}>
          <td title={r.id}>
            {r.name}
            {#each badges(r.id) as b}<span class="badge">{b}</span>{/each}
            {#if r.limited}<span class="badge warn" data-testid="limited">limited connectivity</span>{/if}
          </td>
          <td data-testid="link-status">{r.status}</td>
          <td>{fmtMs(r.rtt)}</td>
          <td>{fmtKbps(r.capacity)}</td>
          <td data-testid="unreachable-count">{r.unreachable || ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
