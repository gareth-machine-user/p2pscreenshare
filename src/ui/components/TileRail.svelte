<script lang="ts" module>
  import type { Player } from '../../media/player'

  export interface Tile {
    publisher: string
    name: string
    /** The preview to draw, or the presenter's own capture. */
    player: Player | null
    localStream: MediaStream | null
    hasAudio: boolean
    selected: boolean
    /** The owner may stop this stream. */
    canStop: boolean
  }
</script>

<script lang="ts">
  import Icon from './Icon.svelte'

  let { tiles, onselect, onstop }: { tiles: Tile[]; onselect: (publisher: string) => void; onstop: (publisher: string) => void } = $props()
  let menuFor = $state<string | null>(null)

  function canvasFor(node: HTMLCanvasElement, player: Player | null) {
    let detach = player?.attach(node)
    return {
      update(p: Player | null) {
        detach?.()
        detach = p?.attach(node)
      },
      destroy() {
        detach?.()
      },
    }
  }

  function videoFor(node: HTMLVideoElement, stream: MediaStream | null) {
    node.srcObject = stream
    return {
      update(s: MediaStream | null) {
        // Re-assigning the same stream restarts playback (a blink).
        if (node.srcObject !== s) node.srcObject = s
      },
    }
  }
</script>

<div class="tile-rail" data-testid="tile-rail">
  {#each tiles as t (t.publisher)}
    <div class="tile" class:selected={t.selected} data-testid="tile" data-publisher={t.publisher}>
      <button class="tile-pick" onclick={() => onselect(t.publisher)} title={`Watch ${t.name}`}>
        {#if t.localStream}
          <video use:videoFor={t.localStream} autoplay muted playsinline></video>
        {:else}
          <canvas use:canvasFor={t.player}></canvas>
        {/if}
        <span class="tile-label">
          {t.name}
          {#if t.hasAudio}<Icon name="volume" size={12} />{/if}
        </span>
      </button>
      {#if t.canStop}
        <button class="tile-menu" data-testid="tile-menu" aria-label="Stream options" onclick={() => (menuFor = menuFor === t.publisher ? null : t.publisher)}>
          <Icon name="more" />
        </button>
        {#if menuFor === t.publisher}
          <div class="menu">
            <button
              data-testid="stop-stream"
              onclick={() => {
                menuFor = null
                onstop(t.publisher)
              }}><Icon name="stop" />Stop stream</button
            >
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</div>
