<script lang="ts">
  import { fmtKbps, fmtMs } from '../route'
  import { fmtMbps, type LivePeerRow } from '../liveRates'

  // Stats: every member's estimated upload (gossiped probe result), and for members this peer is
  // connected to, what flows between you right now (ui/liveRates.ts livePeers).
  let { rows }: { rows: LivePeerRow[] } = $props()
</script>

<h4>Peers</h4>
<div class="table-wrap" data-testid="peer-rates">
  <table>
    <thead>
      <tr>
        <th>Peer</th>
        <th title="Live: what you send to this peer (all connections, last 2 s)">Sending</th>
        <th title="Live: what you receive from this peer (all connections, last 2 s)">Receiving</th>
        <th title="Path round-trip time now / its 2-minute minimum">RTT</th>
        <th class="secondary" title="Measured upload capacity from the last probe; not current use">Upload (est.)</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr data-testid="peer-rate-row" data-peer={r.id} data-direct={r.direct}>
          <td class="name" title={r.id}>{r.name}{r.self ? ' (you)' : ''}</td>
          {#if r.self || r.direct}
            <td class="live" title={r.breakdown}>{fmtMbps(r.sendKbps)}</td>
            <td class="live" title={r.breakdown}>{fmtMbps(r.recvKbps)}</td>
            <td>{r.self ? '' : `${fmtMs(r.rttMs)} / ${fmtMs(r.baselineMs)}`}</td>
          {:else}
            <td colspan="3" class="secondary">not connected</td>
          {/if}
          <td class="secondary"><span class="est">est.</span> {fmtKbps(r.estKbps)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .live {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .est {
    font-size: 11px;
  }
  .name {
    max-width: 10em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
