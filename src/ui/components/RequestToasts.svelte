<script lang="ts">
  import Avatar from './Avatar.svelte'

  let {
    requests,
    onrespond,
  }: {
    requests: { id: string; name: string }[]
    onrespond: (id: string, answer: 'allow' | 'allow-all' | 'deny' | 'deny-all') => void
  } = $props()
</script>

<!-- One person's request is one decision: Allow or Not now. Changing the lobby's policy is the
     quieter link (and the lobby settings). -->
<div class="toasts" aria-live="polite">
  {#each requests as r (r.id)}
    <div class="toast" data-testid="publish-request" data-peer={r.id}>
      <div class="toast-head">
        <Avatar id={r.id} name={r.name} />
        <div><b>{r.name}</b> wants to share their screen</div>
      </div>
      <div class="toast-actions">
        <button data-testid="deny" onclick={() => onrespond(r.id, 'deny')}>Not now</button>
        <button class="primary" data-testid="allow" onclick={() => onrespond(r.id, 'allow')}>Allow</button>
      </div>
      <button class="link" data-testid="allow-all" onclick={() => onrespond(r.id, 'allow-all')}>Let anyone share from now on</button>
    </div>
  {/each}
</div>
