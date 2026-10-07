<script lang="ts">
  /** Owner / presenting badges next to a name. */
  let { list }: { list: string[] } = $props()
  const LABELS: Record<string, { text: string; cls: string }> = {
    owner: { text: 'Owner', cls: '' },
    presenting: { text: 'Live', cls: 'live' },
  }
</script>

{#each list as b}
  <span class="badge {LABELS[b]?.cls ?? ''}">{LABELS[b]?.text ?? b}</span>
{/each}
