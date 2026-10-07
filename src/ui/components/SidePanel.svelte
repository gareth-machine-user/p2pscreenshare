<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    open = $bindable(true),
    count,
    messages,
    chat,
    roster,
  }: {
    open?: boolean
    /** People in the lobby, for the tab. */
    count: number
    /** Chat messages so far (for the unread dot while People is showing). */
    messages: number
    chat: Snippet
    /** The People tab. */
    roster: Snippet
  } = $props()

  let tab = $state<'chat' | 'people'>('chat')
  let seen = $state(0)
  $effect(() => {
    if (tab === 'chat' && open) seen = messages
  })
  const unread = $derived(messages > seen)
</script>

<aside class="side" class:collapsed={!open} data-testid="chat">
  <div class="side-tabs" role="tablist" aria-label="Chat and people">
    {#if open}
      <button role="tab" aria-selected={tab === 'chat'} data-testid="tab-chat" onclick={() => (tab = 'chat')}>
        Chat{#if unread}<span class="unread" aria-label="New messages"></span>{/if}
      </button>
      <button role="tab" aria-selected={tab === 'people'} data-testid="tab-people" onclick={() => (tab = 'people')}>
        People <span class="count">{count}</span>
      </button>
    {/if}
    <button class="collapse" data-testid="chat-toggle" aria-expanded={open} title={open ? 'Hide the side panel' : 'Show chat and people'} onclick={() => (open = !open)}>
      <Icon name={open ? 'sidebar' : 'chat'} />{#if !open}Chat{#if unread}<span class="unread" aria-label="New messages"></span>{/if}{/if}
    </button>
  </div>
  {#if open}
    {#if tab === 'chat'}{@render chat()}{:else}{@render roster()}{/if}
  {/if}
</aside>
