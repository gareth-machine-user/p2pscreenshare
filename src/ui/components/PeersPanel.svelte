<script lang="ts">
  import type { PeerSession } from '../../session/peerSession'
  import { fmtKbps, fmtMs } from '../route'
  import { fmtMbps, sessionPeers } from '../liveRates'

  let {
    session,
    badges,
    tick,
    onkick = null,
  }: { session: PeerSession; badges: (id: string) => string[]; tick: number; onkick?: ((id: string) => void) | null } = $props()

  const fmtBytes = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`)
  /** Peers whose per-connection rows are shown. */
  let expanded = $state(new Set<string>())
  function toggle(id: string): void {
    const next = new Set(expanded)
    if (!next.delete(id)) next.add(id)
    expanded = next
  }

  // Membership comes from gossip records; the live columns from this peer's own per-connection
  // stats (getStats every 2 s, uplink counters), re-read every tick.
  const rows = $derived.by(() => {
    void tick
    const mesh = session.mesh
    const recs = new Map([mesh.record, ...mesh.members()].map((r) => [r.id, r]))
    const all = [...recs.values()]
    const n = all.length
    return sessionPeers(session).map((p) => {
      const r = recs.get(p.id)!
      const self = p.self
      const unreachable = new Set([...r.unreachable, ...all.filter((o) => o.unreachable.includes(r.id)).map((o) => o.id)])
      const path = self ? null : session.pathQueueFor(r.id)
      return {
        id: p.id,
        name: p.name,
        self,
        status: self ? 'you' : mesh.linkStatus(r.id),
        // Media lanes: open connections to this peer (mesh/lanes.ts); TURN-relayed pairs use one.
        lanes: self ? 0 : mesh.laneCount(r.id),
        turn: !self && mesh.lanes.relayed(r.id),
        // Path RTT from getStats; before the first poll, the gossiped one.
        rtt: self ? null : (p.rttMs ?? mesh.record.rtt[r.id] ?? r.rtt[mesh.selfId] ?? null),
        baseline: p.baselineMs,
        // Its uplink's capacity as it gossips it (yours: what you measured), and what your
        // connections to it carry (session/capacity.ts).
        capacity: p.estKbps,
        linkCap: p.capKbps,
        bound: p.bound,
        // Live, on the wire: you → that peer and back; for "you", your totals.
        send: p.sendKbps,
        recv: p.recvKbps,
        breakdown: p.breakdown,
        links: p.links,
        inflationMs: path?.inflationMs ?? null,
        pathQueued: path?.queued ?? false,
        unreachable: unreachable.size,
        // Can't reach a good part of the lobby: it only gets the stripes it can reach.
        limited: n > 2 && unreachable.size >= Math.max(1, Math.floor((n - 1) / 3)),
      }
    })
  })
  const cols = $derived(onkick ? 9 : 8)
</script>

<div class="table-wrap" data-testid="peers-panel">
  <table>
    <thead>
      <tr>
        <th>Peer</th>
        <th title="Live: what you send to this peer right now (all connections, on the wire, last 2 s)">Sending</th>
        <th title="Live: what you receive from this peer right now (on the wire, last 2 s)">Receiving</th>
        <th title="Path round-trip time now / its 2-minute minimum (ICE candidate pair)">RTT now / base</th>
        <th>Link</th>
        <th title="What your connections to this peer carry (most delivered while they were backlogged, or in the last headroom probe); &quot;limit&quot;: the peer's own connection was the bottleneck">Carries</th>
        <th class="secondary" title="The peer's uplink capacity as it measured and gossips it; not current use">Est. upload</th>
        <th>Unreachable</th>
        {#if onkick}<th></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.id)}
        <tr data-testid="peer-row" data-peer={r.id}>
          <td title={r.id}>
            {#if r.links.length}
              <button class="expand" data-testid="expand-lanes" aria-expanded={expanded.has(r.id)} title="Per-connection stats" onclick={() => toggle(r.id)}>{expanded.has(r.id) ? '▾' : '▸'}</button>
            {/if}
            {r.name}
            {#each badges(r.id) as b}<span class="badge">{b}</span>{/each}
            {#if r.limited}<span class="badge warn" data-testid="limited">limited connectivity</span>{/if}
          </td>
          <td class="live" data-testid="live-send" title={r.breakdown}>{fmtMbps(r.send)}</td>
          <td class="live" data-testid="live-recv" title={r.breakdown}>{fmtMbps(r.recv)}</td>
          <td>
            {#if !r.self}{fmtMs(r.rtt)} / {fmtMs(r.baseline)}{/if}
            {#if r.pathQueued}<span class="badge warn" title="Path RTT {r.inflationMs} ms above its baseline: queueing in the network">+{r.inflationMs} ms</span>{/if}
          </td>
          <td data-testid="link-status">{r.status}{#if r.lanes > 1}<span class="badge" data-testid="lanes" title="Connections carrying media to this peer">{r.lanes} lanes</span>{:else if r.turn}<span class="badge" title="Relayed through TURN: a single connection">TURN</span>{/if}</td>
          <td data-testid="link-capacity">{#if !r.self}{fmtKbps(r.linkCap)}{#if r.bound}<span class="badge warn" title="Its connections were backlogged while the rest of your uplink wasn't: this is what they carry">limit</span>{/if}{/if}</td>
          <td class="secondary" data-testid="est-upload" title="The peer's uplink capacity as it measured and gossips it; not current use">{fmtKbps(r.capacity)}</td>
          <td data-testid="unreachable-count">{r.unreachable || ''}</td>
          {#if onkick}
            <td>
              {#if !r.self}<button class="danger" data-testid="kick" onclick={() => onkick?.(r.id)}>Kick</button>{/if}
            </td>
          {/if}
        </tr>
        {#if expanded.has(r.id)}
          {#each r.links as l (l.lane)}
            <tr class="lane-row" data-testid="lane-row" data-peer={r.id} data-lane={l.lane}>
              <td colspan={cols}>
                <span class="lane-name">{l.lane === 0 ? 'mesh link' : `lane ${l.lane}`}</span>
                <span title="Send / receive rate on the wire (getStats)">↑ {fmtMbps(l.sendKbps)} ↓ {fmtMbps(l.recvKbps)}</span>
                <span title="Path RTT now / its 2-minute minimum (ICE candidate pair)" class:stale={!l.fresh}>RTT {fmtMs(l.rttMs)} / {fmtMs(l.baselineMs)}{l.fresh ? '' : ' (stale)'}</span>
                {#if l.queueMs !== null}
                  <span title="Live media: time queued in the uplink and fragments dropped per second; backlogged: its queue never emptied" class:warn={l.backlogged}>queue {fmtMs(l.queueMs)} · {l.drops} drops/s{l.backlogged ? ' · backlogged' : ''}</span>
                {/if}
                {#if l.deliveredKbps !== null || l.capKbps !== null}
                  <span title="Delivered over the last window (all channels) / what this connection carries">delivered {fmtMbps(l.deliveredKbps)} / carries {fmtMbps(l.capKbps)}{l.bound ? ' (limit)' : ''}</span>
                {/if}
                {#if l.stalled}<span class="badge warn" title="This connection's send buffer stopped draining for a while (an SCTP stall, not congestion): its stripes moved to another connection meanwhile" data-testid="lane-stalled">stalled</span>{/if}
                {#if l.relayed}<span class="badge">relayed</span>{/if}
                {#if l.cwnd !== null}<span title="SCTP congestion window">cwnd {fmtBytes(l.cwnd)}</span>{/if}
              </td>
            </tr>
          {/each}
        {/if}
      {/each}
    </tbody>
  </table>
</div>

<style>
  .live {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .secondary {
    color: var(--muted);
  }
  .expand {
    border: none;
    background: none;
    padding: 0 4px 0 0;
    color: var(--muted);
    cursor: pointer;
  }
  .lane-row td {
    font-size: 12px;
    color: var(--muted);
    padding-top: 0;
    padding-left: 18px;
    white-space: normal;
  }
  .lane-row span {
    display: inline-block;
    margin-right: 10px;
  }
  .lane-name {
    min-width: 64px;
  }
  .stale {
    opacity: 0.6;
  }
  .warn {
    color: var(--warn);
  }
</style>
