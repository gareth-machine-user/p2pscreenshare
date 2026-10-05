<script lang="ts">
  import type { Topology } from '../../topology/model'

  let {
    topology,
    hostId,
    stripes,
    names,
  }: { topology: Topology; hostId: string; stripes: number; names: Map<string, string> } = $props()

  const COLORS = ['#4fa3ff', '#ff8a4c', '#3fcf8e', '#d07bff', '#f2c94c', '#ff5d8f', '#50e3c2', '#a0a0ff']
  const DX = 18
  const DY = 46
  const R = 6

  interface Node {
    id: string
    x: number
    y: number
    parent: string | null
  }

  function layout(stripe: number): { nodes: Node[]; width: number; height: number } {
    const kids = new Map<string, string[]>()
    for (const [id, ps] of Object.entries(topology.parents)) {
      const p = ps[stripe]
      if (!p) continue
      if (!kids.has(p)) kids.set(p, [])
      kids.get(p)!.push(id)
    }
    // Relays first among siblings, so leaf fans don't push subtrees apart.
    for (const list of kids.values()) list.sort((a, b) => (kids.get(b)?.length ?? 0) - (kids.get(a)?.length ?? 0) || (a < b ? -1 : 1))
    const nodes: Node[] = []
    let nextX = 0
    let maxDepth = 0
    const visit = (id: string, depth: number, parent: string | null, guard: number): number => {
      maxDepth = Math.max(maxDepth, depth)
      const children = guard < 32 ? (kids.get(id) ?? []) : []
      let x: number
      if (!children.length) {
        x = nextX++
      } else {
        const xs = children.map((c) => visit(c, depth + 1, id, guard + 1))
        x = (Math.min(...xs) + Math.max(...xs)) / 2
      }
      nodes.push({ id, x, y: depth, parent })
      return x
    }
    visit(hostId, 0, null, 0)
    return { nodes, width: Math.max(1, nextX) * DX + 2 * DX, height: (maxDepth + 1) * DY + 20 }
  }

  const layouts = $derived([...Array(stripes).keys()].map((s) => layout(s)))
</script>

<div class="trees">
  {#each layouts as l, s}
    <div class="tree">
      <div class="tree-title" style:color={COLORS[s % COLORS.length]}>stripe {s}</div>
      <svg width={l.width} height={l.height} role="img" aria-label="relay tree for stripe {s}">
        {#each l.nodes as n}
          {#if n.parent}
            {@const p = l.nodes.find((x) => x.id === n.parent)}
            {#if p}
              <line x1={DX + p.x * DX} y1={14 + p.y * DY} x2={DX + n.x * DX} y2={14 + n.y * DY} class="edge" />
            {/if}
          {/if}
        {/each}
        {#each l.nodes as n}
          {@const home = n.id === hostId ? null : topology.home[n.id]}
          <circle
            cx={DX + n.x * DX}
            cy={14 + n.y * DY}
            r={n.id === hostId ? R + 3 : R}
            fill={n.id === hostId ? '#ffffff' : home == null ? 'var(--muted)' : COLORS[home % COLORS.length]}
            class:relay={home === s}
          >
            <title>{n.id === hostId ? 'host' : `${names.get(n.id) ?? n.id} (home ${home ?? '—'})`}</title>
          </circle>
        {/each}
      </svg>
    </div>
  {/each}
</div>
<p class="hint">Node color = the stripe that peer relays in (grey = leaf everywhere). White = host.</p>
