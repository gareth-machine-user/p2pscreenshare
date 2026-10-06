<script lang="ts">
  let {
    requests,
    nameOf,
    onrespond,
  }: {
    requests: { id: string }[]
    nameOf: (id: string) => string
    onrespond: (id: string, answer: 'allow' | 'allow-all' | 'deny' | 'deny-all') => void
  } = $props()
</script>

<div class="toasts" aria-live="polite">
  {#each requests as r (r.id)}
    <div class="toast" data-testid="publish-request" data-peer={r.id}>
      <div><b>{nameOf(r.id)}</b> wants to share their screen.</div>
      <div class="toast-actions">
        <button class="primary" data-testid="allow" onclick={() => onrespond(r.id, 'allow')}>Allow</button>
        <button data-testid="allow-all" onclick={() => onrespond(r.id, 'allow-all')}>Allow all</button>
        <button data-testid="deny" onclick={() => onrespond(r.id, 'deny')}>Deny</button>
        <button data-testid="deny-all" onclick={() => onrespond(r.id, 'deny-all')}>Deny all</button>
      </div>
    </div>
  {/each}
</div>
