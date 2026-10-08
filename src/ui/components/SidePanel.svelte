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
  <div class="side-tabs">
    {#if open}
      <div class="side-tablist" role="tablist" aria-label="Chat and people">
        <button id="side-tab-chat" role="tab" aria-selected={tab === 'chat'} aria-controls="side-panel" data-testid="tab-chat" onclick={() => (tab = 'chat')}>
          Chat{#if unread}<span class="unread" aria-hidden="true"></span><span class="sr-only"> (new messages)</span>{/if}
        </button>
        <button id="side-tab-people" role="tab" aria-selected={tab === 'people'} aria-controls="side-panel" data-testid="tab-people" onclick={() => (tab = 'people')}>
          People <span class="count">{count}</span>
        </button>
      </div>
    {/if}
    <button
      class="collapse"
      data-testid="chat-toggle"
      aria-expanded={open}
      aria-label={open ? 'Hide the side panel' : unread ? 'Show chat and people (new messages)' : 'Show chat and people'}
      title={open ? 'Hide the side panel' : 'Show chat and people'}
      onclick={() => (open = !open)}
    >
      <Icon name={open ? 'sidebar' : 'chat'} />{#if !open && unread}<span class="unread" aria-hidden="true"></span>{/if}
    </button>
  </div>
  {#if open}
    <div class="side-panel" id="side-panel" role="tabpanel" aria-labelledby={tab === 'chat' ? 'side-tab-chat' : 'side-tab-people'}>
      {#if tab === 'chat'}{@render chat()}{:else}{@render roster()}{/if}
    </div>
  {/if}
</aside>
