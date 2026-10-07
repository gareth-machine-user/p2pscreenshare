<script lang="ts">
  // The home page's picture of a lobby: the presenter feeds four relays, which feed everyone else.
  // Stripe 1 follows the tree; stripe 2 reaches the same viewers through other relays.
  type P = [number, number]
  const P0: P = [280, 108]
  const relays: P[] = [[110, 230], [225, 250], [335, 250], [450, 230]]
  const leaves: P[] = [
    [50, 340], [120, 365], [185, 350], [250, 380], [310, 380], [375, 350],
    [440, 365], [510, 340], [165, 440], [290, 460], [405, 440],
  ]
  /** Stripe 1: [relay, leaf] index pairs. */
  const tree: [number, number][] = [[0, 0], [0, 1], [1, 2], [1, 8], [2, 5], [2, 9], [3, 7], [3, 6], [3, 10]]
  const stripe2: [number, number][] = [[0, 3], [3, 4], [1, 5], [2, 2], [1, 1], [2, 6]]
  /** Faint links between neighbours: the full mesh underneath. */
  const mesh: [P, P][] = [
    ...leaves.slice(0, 8).slice(1).map((p, i): [P, P] => [leaves[i], p]),
    [leaves[8], leaves[9]], [leaves[9], leaves[10]], [leaves[1], leaves[8]], [leaves[6], leaves[10]],
    [relays[0], relays[1]], [relays[1], relays[2]], [relays[2], relays[3]],
  ]
</script>

<svg viewBox="0 0 560 500" role="img" aria-label="One presenter sends a stream to four relays, which pass it on to the other viewers">
  <defs>
    <radialGradient id="relay-glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#6aa8ff" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#6aa8ff" stop-opacity="0" />
    </radialGradient>
  </defs>
  <g stroke="#1c222c" stroke-width="1">
    {#each mesh as [a, b]}<line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} />{/each}
  </g>
  <g stroke="#b49cff" stroke-width="1.4" stroke-linecap="round" opacity="0.75" class="flow2">
    {#each stripe2 as [r, l]}<line x1={relays[r][0]} y1={relays[r][1]} x2={leaves[l][0]} y2={leaves[l][1]} />{/each}
  </g>
  <g stroke="#6aa8ff" stroke-width="1.8" stroke-linecap="round" class="flow">
    {#each relays as r}<line x1={P0[0]} y1={P0[1]} x2={r[0]} y2={r[1]} />{/each}
    {#each tree as [r, l]}<line x1={relays[r][0]} y1={relays[r][1]} x2={leaves[l][0]} y2={leaves[l][1]} />{/each}
  </g>
  <circle cx="280" cy="74" r="96" fill="url(#relay-glow)" opacity="0.35" class="glow" />
  <rect x="226" y="40" width="108" height="68" rx="10" fill="#141922" stroke="#6aa8ff" stroke-width="2" />
  <rect x="236" y="50" width="26" height="48" rx="3" fill="#1e2532" />
  <rect x="268" y="52" width="56" height="6" rx="3" fill="#6aa8ff" opacity="0.9" />
  <rect x="268" y="64" width="44" height="5" rx="2.5" fill="#3a4558" />
  <rect x="268" y="74" width="50" height="5" rx="2.5" fill="#3a4558" />
  <rect x="268" y="84" width="34" height="5" rx="2.5" fill="#3a4558" />
  <text x="280" y="28" text-anchor="middle" fill="#c9d0db" font-size="13" font-weight="600">Presenter</text>
  {#each relays as [x, y]}
    <circle cx={x} cy={y} r="15" fill="#18202c" stroke="#6aa8ff" stroke-width="1.8" />
    <circle cx={x} cy={y} r="4" fill="#6aa8ff" />
  {/each}
  {#each leaves as [x, y]}<circle cx={x} cy={y} r="10" fill="#12161d" stroke="#3a4352" stroke-width="1.4" />{/each}
</svg>
