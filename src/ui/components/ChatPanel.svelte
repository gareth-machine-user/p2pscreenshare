<script lang="ts">
  import { CHAT_MAX_LEN, type ChatMessage } from '../../mesh/mesh'
  import Icon from './Icon.svelte'

  let {
    messages,
    selfId,
    badges,
    open = $bindable(true),
    onsend,
  }: {
    messages: ChatMessage[]
    selfId: string
    /** Badge text per peer id (owner, presenter). */
    badges: (id: string) => string[]
    open?: boolean
    /** Returns false when rate limited. */
    onsend: (text: string) => boolean
  } = $props()

  let draft = $state('')
  let limited = $state(false)
  let list: HTMLDivElement | undefined = $state()

  $effect(() => {
    void messages.length
    if (list) list.scrollTop = list.scrollHeight
  })

  function send(e: SubmitEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    if (onsend(draft)) {
      draft = ''
      limited = false
    } else {
      limited = true
    }
  }

  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<aside class="chat" class:collapsed={!open} data-testid="chat">
  <button class="chat-toggle" data-testid="chat-toggle" aria-expanded={open} onclick={() => (open = !open)} title={open ? 'Hide chat' : 'Show chat'}>
    <Icon name="chat" />{open ? 'Chat' : ''}
  </button>
  {#if open}
    <div class="chat-list" bind:this={list} data-testid="chat-list">
      {#each messages as m (m.id)}
        <div class="chat-msg" class:mine={m.from === selfId} data-testid="chat-msg">
          <div class="chat-meta">
            <b>{m.name || m.from.slice(0, 6)}</b>
            {#each badges(m.from) as b}<span class="badge">{b}</span>{/each}
            <span class="chat-time">{time(m.at)}</span>
          </div>
          <div class="chat-text">{m.text}</div>
        </div>
      {:else}
        <p class="hint">No messages yet.</p>
      {/each}
    </div>
    <form class="chat-form" onsubmit={send}>
      <input data-testid="chat-input" placeholder="Message the lobby" maxlength={CHAT_MAX_LEN} bind:value={draft} />
      <button type="submit" data-testid="chat-send">Send</button>
    </form>
    {#if limited}<p class="hint">Slow down a little.</p>{/if}
  {/if}
</aside>
